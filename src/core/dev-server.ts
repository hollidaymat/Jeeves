/**
 * Dev Server Management
 * Manages development servers for live preview during coding
 * 
 * Features:
 * - Start/stop dev servers for different frameworks
 * - Auto-detect when server is ready
 * - Track multiple servers per project
 * - Visual feedback integration with browser module
 * - Hot reload detection
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { browse, takeScreenshot, isBrowserOpen, closeBrowser } from './browser.js';

// Dev server instance tracking
interface DevServerInstance {
  projectPath: string;
  projectName: string;
  framework: string;
  command: string;
  port: number;
  url: string;
  process: ChildProcess;
  pid: number;
  startedAt: Date;
  ready: boolean;
  output: string[];
}

// Active dev servers
const activeServers: Map<string, DevServerInstance> = new Map();

// Framework detection and commands
interface FrameworkConfig {
  name: string;
  detect: (projectPath: string) => boolean;
  command: string;
  defaultPort: number;
  readyPatterns: RegExp[];
}

const FRAMEWORKS: FrameworkConfig[] = [
  {
    name: 'next',
    detect: (path) => {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
        return 'next' in (pkg.dependencies || {}) || 'next' in (pkg.devDependencies || {});
      } catch { return false; }
    },
    command: 'npm run dev',
    defaultPort: 3000,
    readyPatterns: [
      /ready.*localhost:(\d+)/i,
      /started.*localhost:(\d+)/i,
      /Local:\s+http:\/\/localhost:(\d+)/i
    ]
  },
  {
    name: 'vite',
    detect: (path) => {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
        return 'vite' in (pkg.dependencies || {}) || 'vite' in (pkg.devDependencies || {});
      } catch { return false; }
    },
    command: 'npm run dev',
    defaultPort: 5173,
    readyPatterns: [
      /Local:\s+http:\/\/localhost:(\d+)/i,
      /ready in \d+/i
    ]
  },
  {
    name: 'create-react-app',
    detect: (path) => {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
        return 'react-scripts' in (pkg.dependencies || {}) || 'react-scripts' in (pkg.devDependencies || {});
      } catch { return false; }
    },
    command: 'npm start',
    defaultPort: 3000,
    readyPatterns: [
      /Compiled successfully/i,
      /localhost:(\d+)/i
    ]
  },
  {
    name: 'expo',
    detect: (path) => {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8'));
        return 'expo' in (pkg.dependencies || {}) || 'expo' in (pkg.devDependencies || {});
      } catch { return false; }
    },
    command: 'npx expo start --web',
    defaultPort: 8081,
    readyPatterns: [
      /Web is waiting on/i,
      /localhost:(\d+)/i
    ]
  },
  {
    name: 'generic',
    detect: () => true,  // Fallback
    command: 'npm run dev',
    defaultPort: 3000,
    readyPatterns: [
      /localhost:(\d+)/i,
      /listening on/i,
      /ready/i,
      /started/i
    ]
  }
];

// Visual feedback settings
interface VisualFeedbackConfig {
  enabled: boolean;
  autoScreenshot: boolean;
  screenshotDelayMs: number;
  analyzeWithVision: boolean;
}

let visualFeedbackConfig: VisualFeedbackConfig = {
  enabled: true,
  autoScreenshot: true,
  screenshotDelayMs: 2000,  // Wait for hot reload
  analyzeWithVision: false  // Requires Claude vision integration
};

/**
 * Detect the framework for a project
 */
function detectFramework(projectPath: string): FrameworkConfig {
  for (const framework of FRAMEWORKS) {
    if (framework.detect(projectPath)) {
      logger.debug('Detected framework', { framework: framework.name, projectPath });
      return framework;
    }
  }
  return FRAMEWORKS[FRAMEWORKS.length - 1];  // Generic fallback
}

/**
 * Extract port from server output
 */
function extractPort(output: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      const port = parseInt(match[1], 10);
      if (!isNaN(port)) {
        return port;
      }
    }
  }
  return null;
}

/**
 * Start a dev server for a project
 */
export async function startDevServer(
  projectPath: string,
  options?: {
    command?: string;
    port?: number;
    openBrowser?: boolean;
  }
): Promise<{
  success: boolean;
  message: string;
  url?: string;
  port?: number;
}> {
  // Check if already running
  const existing = activeServers.get(projectPath);
  if (existing && existing.ready) {
    return {
      success: true,
      message: `Dev server already running at ${existing.url}`,
      url: existing.url,
      port: existing.port
    };
  }

  // Detect framework
  const framework = detectFramework(projectPath);
  const command = options?.command || framework.command;
  const port = options?.port || framework.defaultPort;
  
  logger.info('Starting dev server', { 
    projectPath, 
    framework: framework.name, 
    command,
    port 
  });

  return new Promise((resolve) => {
    try {
      // Parse command
      const parts = command.split(' ');
      const cmd = parts[0];
      const args = parts.slice(1);

      // Spawn the process
      const proc = spawn(cmd, args, {
        cwd: projectPath,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: port.toString(),
          BROWSER: 'none'  // Don't auto-open browser
        }
      });

      const projectName = projectPath.split(/[/\\]/).pop() || 'unknown';
      const url = `http://localhost:${port}`;

      const instance: DevServerInstance = {
        projectPath,
        projectName,
        framework: framework.name,
        command,
        port,
        url,
        process: proc,
        pid: proc.pid || 0,
        startedAt: new Date(),
        ready: false,
        output: []
      };

      activeServers.set(projectPath, instance);

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Even if not detected as ready, might still work
          instance.ready = true;
          logger.warn('Dev server startup timeout, assuming ready', { url });
          
          if (options?.openBrowser) {
            openDevPreview(projectPath).catch(() => {});
          }
          
          resolve({
            success: true,
            message: `Dev server started (timeout, assuming ready) at ${url}`,
            url,
            port
          });
        }
      }, 30000);  // 30 second timeout

      // Collect output
      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        instance.output.push(text);
        
        // Keep only last 100 lines
        if (instance.output.length > 100) {
          instance.output.shift();
        }

        // Check if ready
        if (!resolved) {
          const fullOutput = instance.output.join('\n');
          const detectedPort = extractPort(fullOutput, framework.readyPatterns);
          
          // Check for ready patterns
          for (const pattern of framework.readyPatterns) {
            if (pattern.test(fullOutput)) {
              resolved = true;
              clearTimeout(timeout);
              
              if (detectedPort) {
                instance.port = detectedPort;
                instance.url = `http://localhost:${detectedPort}`;
              }
              instance.ready = true;
              
              logger.info('Dev server ready', { 
                url: instance.url, 
                framework: framework.name 
              });
              
              if (options?.openBrowser) {
                openDevPreview(projectPath).catch(() => {});
              }
              
              resolve({
                success: true,
                message: `Dev server ready at ${instance.url}`,
                url: instance.url,
                port: instance.port
              });
              break;
            }
          }
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      proc.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          activeServers.delete(projectPath);
          resolve({
            success: false,
            message: `Failed to start dev server: ${error.message}`
          });
        }
      });

      proc.on('exit', (code) => {
        logger.info('Dev server exited', { projectPath, code });
        activeServers.delete(projectPath);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            success: false,
            message: `Dev server exited with code ${code}`
          });
        }
      });

    } catch (error) {
      resolve({
        success: false,
        message: `Error starting dev server: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });
}

/**
 * Stop a dev server
 */
export function stopDevServer(projectPath: string): { success: boolean; message: string } {
  const instance = activeServers.get(projectPath);
  
  if (!instance) {
    return {
      success: false,
      message: 'No dev server running for this project'
    };
  }

  try {
    // Kill the process tree on Windows
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', instance.pid.toString(), '/T', '/F'], { shell: true });
    } else {
      instance.process.kill('SIGTERM');
    }
    
    activeServers.delete(projectPath);
    logger.info('Dev server stopped', { projectPath });
    
    return {
      success: true,
      message: `Stopped dev server for ${instance.projectName}`
    };
  } catch (error) {
    return {
      success: false,
      message: `Error stopping dev server: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Stop all dev servers
 */
export function stopAllDevServers(): { success: boolean; message: string } {
  const count = activeServers.size;
  
  for (const [path] of activeServers) {
    stopDevServer(path);
  }
  
  return {
    success: true,
    message: count > 0 ? `Stopped ${count} dev server(s)` : 'No dev servers were running'
  };
}

/**
 * Open the dev server in the browser for preview
 */
export async function openDevPreview(projectPath: string): Promise<{
  success: boolean;
  message: string;
  screenshotPath?: string;
}> {
  const instance = activeServers.get(projectPath);
  
  if (!instance) {
    return {
      success: false,
      message: 'No dev server running for this project. Start one first.'
    };
  }

  if (!instance.ready) {
    return {
      success: false,
      message: 'Dev server is still starting. Please wait.'
    };
  }

  try {
    const result = await browse(instance.url, { screenshot: true });
    
    if (!result.success) {
      return {
        success: false,
        message: `Failed to open preview: ${result.error}`
      };
    }

    return {
      success: true,
      message: `Preview opened: ${instance.url}`,
      screenshotPath: result.screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      message: `Error opening preview: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Take a screenshot of the current dev preview
 * Called after code changes for visual feedback
 */
export async function capturePreview(projectPath?: string): Promise<{
  success: boolean;
  message: string;
  screenshotPath?: string;
  screenshotBase64?: string;
}> {
  // If project specified, make sure we're on that server
  if (projectPath) {
    const instance = activeServers.get(projectPath);
    if (!instance) {
      return {
        success: false,
        message: 'No dev server running for this project'
      };
    }
    
    // Navigate to the server if browser is on different page
    const result = await browse(instance.url, { screenshot: true });
    return {
      success: result.success,
      message: result.success ? 'Preview captured' : (result.error || 'Failed to capture'),
      screenshotPath: result.screenshotPath,
      screenshotBase64: result.screenshotBase64
    };
  }

  // Otherwise just screenshot current page
  if (!isBrowserOpen()) {
    return {
      success: false,
      message: 'No browser open. Start a dev server and open preview first.'
    };
  }

  try {
    const screenshotPath = await takeScreenshot();
    return {
      success: true,
      message: 'Preview captured',
      screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      message: `Error capturing preview: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Wait for hot reload and capture screenshot
 * Called after making code changes
 */
export async function captureAfterChange(
  projectPath: string,
  delayMs?: number
): Promise<{
  success: boolean;
  message: string;
  screenshotPath?: string;
}> {
  const delay = delayMs || visualFeedbackConfig.screenshotDelayMs;
  
  // Wait for hot reload
  logger.debug('Waiting for hot reload', { delayMs: delay });
  await new Promise(resolve => setTimeout(resolve, delay));
  
  return capturePreview(projectPath);
}

/**
 * Get status of all dev servers
 */
export function getDevServerStatus(): string {
  if (activeServers.size === 0) {
    return 'No dev servers running.';
  }

  const lines = ['**Active Dev Servers:**', ''];
  
  for (const [path, instance] of activeServers) {
    const uptime = Math.floor((Date.now() - instance.startedAt.getTime()) / 1000);
    lines.push(`**${instance.projectName}** (${instance.framework})`);
    lines.push(`  URL: ${instance.url}`);
    lines.push(`  Status: ${instance.ready ? '✓ Ready' : '⏳ Starting...'}`);
    lines.push(`  PID: ${instance.pid}`);
    lines.push(`  Uptime: ${uptime}s`);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Get a specific dev server instance
 */
export function getDevServer(projectPath: string): DevServerInstance | undefined {
  return activeServers.get(projectPath);
}

/**
 * Check if a dev server is running for a project
 */
export function isDevServerRunning(projectPath: string): boolean {
  const instance = activeServers.get(projectPath);
  return instance?.ready || false;
}

/**
 * Configure visual feedback settings
 */
export function configureVisualFeedback(config: Partial<VisualFeedbackConfig>): void {
  visualFeedbackConfig = { ...visualFeedbackConfig, ...config };
  logger.info('Visual feedback configured', { ...visualFeedbackConfig });
}

/**
 * Get visual feedback config
 */
export function getVisualFeedbackConfig(): VisualFeedbackConfig {
  return { ...visualFeedbackConfig };
}

/**
 * Cleanup on process exit
 */
process.on('exit', () => {
  stopAllDevServers();
  closeBrowser().catch(() => {});
});

process.on('SIGINT', () => {
  stopAllDevServers();
  closeBrowser().catch(() => {});
  process.exit(0);
});

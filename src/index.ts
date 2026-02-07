/**
 * Jeeves - Your AI Employee
 * Main entry point
 * Updated: max_tokens now 8000 for complete file generation
 */

import { config, validateConfig } from './config.js';
import { logger } from './utils/logger.js';
import { scanProjects } from './core/project-scanner.js';
import { registerInterface, handleMessage, sendResponse } from './core/handler.js';
import { webInterface } from './interfaces/web.js';
import { mockInterface } from './interfaces/mock.js';
import { signalInterface } from './interfaces/signal.js';
import { initMemory } from './core/memory.js';
import { initTrust } from './core/trust.js';

async function main() {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║        ██╗███████╗███████╗██╗   ██╗███████╗███████╗       ║
  ║        ██║██╔════╝██╔════╝██║   ██║██╔════╝██╔════╝       ║
  ║        ██║█████╗  █████╗  ██║   ██║█████╗  ███████╗       ║
  ║   ██   ██║██╔══╝  ██╔══╝  ╚██╗ ██╔╝██╔══╝  ╚════██║       ║
  ║   ╚█████╔╝███████╗███████╗ ╚████╔╝ ███████╗███████║       ║
  ║    ╚════╝ ╚══════╝╚══════╝  ╚═══╝  ╚══════╝╚══════╝       ║
  ║                                                           ║
  ║   JEEVES v2.0.0                                           ║
  ║   Your AI Employee                                        ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  // Validate configuration
  const validation = validateConfig();
  if (!validation.valid) {
    logger.error('Configuration validation failed:');
    validation.errors.forEach(err => logger.error(`  - ${err}`));
    logger.info('Copy config.example.json to config.json and update settings');
    logger.info('Set ANTHROPIC_API_KEY in .env file');
    process.exit(1);
  }

  // Scan for projects
  logger.info('Initializing...');
  const projectIndex = scanProjects();
  logger.info(`Loaded ${projectIndex.projects.size} projects`);

  // Initialize memory system
  initMemory();

  // Initialize trust system
  initTrust();

  // Set up message handling
  const messageHandler = async (message: Parameters<typeof handleMessage>[0]) => {
    const response = await handleMessage(message);
    if (response) {
      await sendResponse(response, message.interface);
    }
  };

  // Register and start web interface
  webInterface.onMessage(messageHandler);
  registerInterface(webInterface);
  await webInterface.start();

  // Register mock interface for testing
  mockInterface.onMessage(messageHandler);
  registerInterface(mockInterface);
  await mockInterface.start();

  // Register and start Signal interface (Linux only)
  signalInterface.onMessage(messageHandler);
  registerInterface(signalInterface);
  await signalInterface.start();

  // Start Knowledge Scout loop
  try {
    const { startScoutLoop } = await import('./capabilities/scout/loop.js');
    startScoutLoop();
    logger.info('Knowledge Scout started');
  } catch (err) {
    logger.debug('Knowledge Scout not started', { error: String(err) });
  }

  // Start Security Monitor
  try {
    const { startSecurityMonitor, setSecurityBroadcast } = await import('./capabilities/security/monitor.js');
    startSecurityMonitor();
    // Wire security broadcasts to web UI
    import('./interfaces/web.js').then(({ webInterface }) => {
      setSecurityBroadcast((type, payload) => {
        (webInterface as any).broadcast?.({ type, payload });
      });
    }).catch(() => {});
    logger.info('Security Guardian started');
  } catch (err) {
    logger.debug('Security Guardian not started', { error: String(err) });
  }

  // Initialize Decision Recording
  try {
    const { initDecisionTable } = await import('./capabilities/twin/decision-recorder.js');
    initDecisionTable();
    logger.info('Decision recorder initialized');
  } catch (err) {
    logger.debug('Decision recorder not started', { error: String(err) });
  }

  logger.info('System ready');
  logger.info(`Open http://${config.server.host}:${config.server.port} in your browser`);
  if (signalInterface.isAvailable()) {
    logger.info(`Signal interface active - send messages to ${config.signal.number}`);
  } else if (process.platform !== 'win32') {
    logger.info('Signal interface offline - check signal-cli daemon');
  }
  logger.info('Press Ctrl+C to stop');

  // Graceful shutdown handler
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    logger.info(`Shutting down (${signal})...`);
    
    try {
      // Close all interfaces
      await Promise.race([
        Promise.all([
          signalInterface.stop().catch(() => {}),
          webInterface.stop().catch(() => {}),
          mockInterface.stop().catch(() => {})
        ]),
        new Promise(resolve => setTimeout(resolve, 2000)) // 2s timeout
      ]);
    } catch {
      // Ignore errors during shutdown
    }

      // Stop background loops
      try {
        const { stopScoutLoop } = await import('./capabilities/scout/loop.js');
        stopScoutLoop();
      } catch {}
      try {
        const { stopSecurityMonitor } = await import('./capabilities/security/monitor.js');
        stopSecurityMonitor();
      } catch {}
    
    process.exit(0);
  };

  // Handle various shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  
  // Handle tsx watch restarts on Windows
  process.on('exit', () => {
    if (!isShuttingDown) {
      try {
        webInterface.stop().catch(() => {});
      } catch {
        // Ignore
      }
    }
  });

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: String(error) });
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.error('Fatal error:', { error: String(error) });
  process.exit(1);
});

/**
 * Jeeves - Your AI Employee
 * Main entry point
 */

import { config, validateConfig } from './config.js';
import { logger } from './utils/logger.js';
import { scanProjects } from './core/project-scanner.js';
import { registerInterface, handleMessage, sendResponse } from './core/handler.js';
import { webInterface } from './interfaces/web.js';
import { mockInterface } from './interfaces/mock.js';
import { signalInterface } from './interfaces/signal.js';

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

  logger.info('System ready');
  logger.info(`Open http://${config.server.host}:${config.server.port} in your browser`);
  if (signalInterface.isAvailable()) {
    logger.info(`Signal interface active - send messages to ${config.signal.number}`);
  } else if (process.platform !== 'win32') {
    logger.info('Signal interface offline - check signal-cli daemon');
  }
  logger.info('Press Ctrl+C to stop');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await signalInterface.stop();
    await webInterface.stop();
    await mockInterface.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await signalInterface.stop();
    await webInterface.stop();
    await mockInterface.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error:', { error: String(error) });
  process.exit(1);
});

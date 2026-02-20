/**
 * Jeeves - Your AI Employee
 * Main entry point
 * Updated: max_tokens now 8000 for complete file generation
 */

import { config, validateConfig, getOwnerNumber } from './config.js';
import { logger } from './utils/logger.js';
import { generateUUID } from './utils/uuid.js';
import { scanProjects } from './core/project-scanner.js';
import { registerInterface, handleMessage, sendResponse } from './core/handler.js';
import { webInterface } from './interfaces/web.js';
import { mockInterface } from './interfaces/mock.js';
import { signalInterface } from './interfaces/signal.js';
import { initMemory } from './core/memory.js';
import { initTrust } from './core/trust.js';

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

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

  // Initialize alias store (learned command aliases)
  const { initAliasStore } = await import('./core/alias-store.js');
  await initAliasStore();

  // Reclassify existing reasoning_tasks with current task-type logic (fix/review/refactor/develop)
  setImmediate(() => {
    import('./core/reasoning-recorder.js').then(({ reclassifyReasoningTasks }) => {
      reclassifyReasoningTasks();
    }).catch(() => {});
  });

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
  if (config.voice?.enabled) {
    logger.info('Voice tablet interface available at /voice and /voice/test');
  }

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

  // Start Self-Update Checker
  try {
    const { startUpdateChecker, setUpdateBroadcast, setActiveTaskChecker } = await import('./capabilities/self/updater.js');
    // Wire broadcasts
    import('./interfaces/web.js').then(({ webInterface }) => {
      setUpdateBroadcast((type, payload) => {
        (webInterface as any).broadcast?.({ type, payload });
      });
    }).catch(() => {});
    // Wire active task checker
    import('./integrations/cursor-orchestrator.js').then(({ getActiveCursorTasks }) => {
      setActiveTaskChecker(() => getActiveCursorTasks().length > 0);
    }).catch(() => {});
    startUpdateChecker();
    logger.info('Self-update checker started');
  } catch (err) {
    logger.debug('Self-update checker not started', { error: String(err) });
  }

  // Start Scheduler + register all handler functions
  try {
    const { startScheduler } = await import('./capabilities/scheduler/engine.js');
    
    // Register scheduled task handlers
    const { registerBriefingHandler } = await import('./capabilities/scheduler/briefing.js');
    registerBriefingHandler();
    
    const { registerUptimeHandler } = await import('./capabilities/security/uptime.js');
    registerUptimeHandler();
    
    const { registerChangelogHandler } = await import('./capabilities/self/changelog.js');
    registerChangelogHandler();
    
    const { registerCostAdvisorHandler } = await import('./capabilities/revenue/cost-advisor.js');
    registerCostAdvisorHandler();

    // Register new monitoring scheduled handlers
    const { registerHandler, addSchedule } = await import('./capabilities/scheduler/engine.js');

    // Daily SMART disk health check
    registerHandler('disk_health_check', async () => {
      try {
        const { getSmartHealth } = await import('./homelab/system/smart-monitor.js');
        const report = await getSmartHealth();
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        addTimelineEvent('scheduler', 'system', `Disk health check: ${report.summary}`, report.overallHealthy ? 'info' : 'warning');
        if (!report.overallHealthy && signalInterface.isAvailable()) {
          const { isMuted, shouldSendNow, queueNotification } = await import('./capabilities/notifications/quiet-hours.js');
          if (!isMuted()) {
            const msg = `⚠️ Disk health alert: ${report.summary}`;
            if (shouldSendNow('critical')) {
              await signalInterface.send({ recipient: getOwnerNumber(), content: msg });
            } else {
              queueNotification(msg, 'critical', 'disk-health');
            }
          }
        }
      } catch { /* ignore */ }
    });
    addSchedule('Daily disk health', '06:00', 'disk_health_check');

    // Weekly Docker cleanup
    registerHandler('docker_cleanup', async () => {
      try {
        const { runCleanup } = await import('./homelab/system/docker-cleanup.js');
        const result = await runCleanup();
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        addTimelineEvent('scheduler', 'system', `Docker cleanup: ${result.message}`, 'info');
      } catch { /* ignore */ }
    });
    addSchedule('Weekly Docker cleanup', '03:00:0', 'docker_cleanup'); // Sunday 3am

    // Daily container log scan
    registerHandler('log_error_scan', async () => {
      try {
        const { scanContainerLogs } = await import('./homelab/system/log-scanner.js');
        const result = await scanContainerLogs(1440); // last 24h
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        if (result.errors.length > 0) {
          addTimelineEvent('scheduler', 'system', `Log scan: ${result.errors.length} errors across ${result.containersScanned} containers`, 'warning');
        }
      } catch { /* ignore */ }
    });
    addSchedule('Daily log error scan', '07:00', 'log_error_scan');

    // Daily SSL cert check
    registerHandler('ssl_cert_check', async () => {
      try {
        const { checkCertificates } = await import('./homelab/system/ssl-monitor.js');
        const report = await checkCertificates();
        const expiring = report.certs.filter(c => c.status !== 'ok');
        if (expiring.length > 0 && signalInterface.isAvailable()) {
          const { isMuted, shouldSendNow, queueNotification } = await import('./capabilities/notifications/quiet-hours.js');
          if (!isMuted()) {
            const msg = `🔒 SSL alert: ${expiring.map(c => `${c.domain} (${c.daysLeft}d)`).join(', ')}`;
            if (shouldSendNow('critical')) {
              await signalInterface.send({ recipient: getOwnerNumber(), content: msg });
            } else {
              queueNotification(msg, 'critical', 'ssl-monitor');
            }
          }
        }
      } catch { /* ignore */ }
    });
    addSchedule('Daily SSL cert check', '08:00', 'ssl_cert_check');

    // Daily image update check
    registerHandler('image_update_check', async () => {
      try {
        const { checkImageUpdates } = await import('./homelab/system/image-updates.js');
        const result = await checkImageUpdates();
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        addTimelineEvent('scheduler', 'system', `Image update check: ${result.message}`, 'info');
      } catch { /* ignore */ }
    });
    addSchedule('Daily image update check', '09:00', 'image_update_check');

    // Daily speed test
    registerHandler('speed_test', async () => {
      try {
        const { runSpeedTest } = await import('./homelab/system/speed-test.js');
        const result = await runSpeedTest();
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        if (result) {
          addTimelineEvent('scheduler', 'system', `Speed test: ${result.download} Mbps down / ${result.upload} Mbps up`, 'info');
        }
      } catch { /* ignore */ }
    });
    addSchedule('Daily speed test', '12:00', 'speed_test');

    // Custom schedule executor (runs every minute to check if any custom schedules are due)
    registerHandler('custom_schedule_check', async () => {
      try {
        const { getSchedulesDueNow } = await import('./capabilities/scheduler/custom-schedules.js');
        const due = getSchedulesDueNow();
        const { isMuted } = await import('./capabilities/notifications/quiet-hours.js');
        for (const schedule of due) {
          if (!isMuted() && signalInterface.isAvailable()) {
            await signalInterface.send({
              recipient: getOwnerNumber(),
              content: `📋 Scheduled: ${schedule.action}`,
            });
          }
        }
      } catch { /* ignore */ }
    });
    addSchedule('Custom schedule check', 60000, 'custom_schedule_check'); // Every 60 seconds

    // Quiet hours flush (deliver queued notifications when quiet hours end)
    registerHandler('quiet_hours_flush', async () => {
      try {
        const { isQuietHours, flushQueue } = await import('./capabilities/notifications/quiet-hours.js');
        if (!isQuietHours()) {
          const { isMuted } = await import('./capabilities/notifications/quiet-hours.js');
          const queued = flushQueue();
          if (queued.length > 0 && !isMuted() && signalInterface.isAvailable()) {
            const summary = queued.map(n => n.message).join('\n');
            await signalInterface.send({
              recipient: getOwnerNumber(),
              content: `📬 While you were away (${queued.length} notifications):\n\n${summary}`,
            });
          }
        }
      } catch { /* ignore */ }
    });
    addSchedule('Quiet hours flush', 300000, 'quiet_hours_flush'); // Every 5 minutes

    // Performance profiler: bottleneck detection every 5 min, optimizer daily, cleanup daily
    registerHandler('bottleneck_detection', async () => {
      try {
        const { runBottleneckDetection } = await import('./core/profiler/bottleneck-detector.js');
        await runBottleneckDetection();
      } catch { /* ignore */ }
    });
    addSchedule('Bottleneck detection', 5 * 60 * 1000, 'bottleneck_detection');
    registerHandler('performance_optimizer', async () => {
      try {
        const { runOptimizer } = await import('./core/profiler/optimizer.js');
        await runOptimizer();
      } catch { /* ignore */ }
    });
    addSchedule('Performance optimizer', '03:00', 'performance_optimizer');
    registerHandler('performance_cleanup', async () => {
      try {
        const { runPerformanceCleanup } = await import('./core/profiler/cleanup.js');
        runPerformanceCleanup();
      } catch { /* ignore */ }
    });
    addSchedule('Performance cleanup', '04:00', 'performance_cleanup');

    const playbookIntervalMs = parseInt(process.env.PLAYBOOK_UPDATE_INTERVAL_MS || '300000', 10) || 300000;
    registerHandler('playbook_update', async () => {
      try {
        const { runPlaybookGenerator } = await import('./core/observer/playbook-generator.js');
        runPlaybookGenerator();
      } catch { /* ignore */ }
    });
    addSchedule('Playbook update', playbookIntervalMs, 'playbook_update');

    startScheduler();
    logger.info('Scheduler started with default schedules');
  } catch (err) {
    logger.debug('Scheduler not started', { error: String(err) });
  }

  // Performance profiler: system monitor (60s snapshots)
  try {
    const { startSystemMonitor } = await import('./core/profiler/system-monitor.js');
    startSystemMonitor();
  } catch (err) {
    logger.debug('Performance system monitor not started', { error: String(err) });
  }

  // Initialize Download Watcher callbacks
  try {
    const { onDownloadComplete, onDownloadStall, setDownloadBroadcast } = await import('./homelab/media/download-watcher.js');

    // Signal notification on completion (respects quiet hours)
    onDownloadComplete(async (download) => {
      if (signalInterface.isAvailable()) {
        const icon = download.type === 'movie' ? '🎬' : '📺';
        const size = download.size ? ` (${download.size})` : '';
        const duration = download.completedAt && download.addedAt
          ? ` in ${formatDuration(download.completedAt - download.addedAt)}`
          : '';
        const message = `${icon} Download complete: ${download.title}${size}${duration}`;
        try {
          const { isMuted, shouldSendNow, queueNotification } = await import('./capabilities/notifications/quiet-hours.js');
          if (!isMuted()) {
            if (shouldSendNow('normal')) {
              await signalInterface.send({ recipient: getOwnerNumber(), content: message });
            } else {
              queueNotification(message, 'normal', 'download-watcher');
            }
          }
        } catch {
          await signalInterface.send({ recipient: getOwnerNumber(), content: message });
        }
        if (config.voice?.enabled) {
          import('./integrations/voice/voice-server.js').then(({ broadcastVoiceNotification }) => {
            broadcastVoiceNotification({ message, priority: 'normal', title: 'Download' });
          }).catch(() => {});
        }
        // Log to timeline
        try {
          const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
          addTimelineEvent('download-watcher', 'download', `Completed: ${download.title}`, 'info');
        } catch { /* skip */ }
      }
    });

    // Log stalls (could also alert via Signal if desired)
    onDownloadStall(async (download, action) => {
      logger.warn('[download-watcher] Stall detected', { title: download.title, action });
      // Log to timeline
      try {
        const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
        addTimelineEvent('download-watcher', 'download', `Stall: ${download.title} — ${action}`, 'warning');
      } catch { /* skip */ }
      // Notify via Signal for restarts (respects mute)
      if (download.restarted && signalInterface.isAvailable()) {
        const stallMessage = `⚠️ ${action}`;
        try {
          const { isMuted } = await import('./capabilities/notifications/quiet-hours.js');
          if (!isMuted()) {
            await signalInterface.send({
              recipient: getOwnerNumber(),
              content: stallMessage,
            });
          }
        } catch {
          await signalInterface.send({ recipient: getOwnerNumber(), content: stallMessage });
        }
        if (config.voice?.enabled) {
          import('./integrations/voice/voice-server.js').then(({ broadcastVoiceNotification }) => {
            broadcastVoiceNotification({ message: stallMessage, priority: 'high', title: 'Download' });
          }).catch(() => {});
        }
      }
    });

    // WebSocket broadcast
    import('./interfaces/web.js').then(({ webInterface }) => {
      setDownloadBroadcast((status) => {
        (webInterface as any).broadcast?.({ type: 'download_status', payload: status });
      });
    }).catch(() => {});

    logger.info('Download watcher callbacks registered');
  } catch (err) {
    logger.debug('Download watcher not initialized', { error: String(err) });
  }

  // Initialize Reminders (re-schedule pending from disk)
  try {
    const { initReminders, setReminderCallback } = await import('./capabilities/reminders/reminders.js');
    setReminderCallback(async (message: string) => {
      if (signalInterface.isAvailable()) {
        try {
          const { isMuted } = await import('./capabilities/notifications/quiet-hours.js');
          if (!isMuted()) {
            await signalInterface.send({
              recipient: getOwnerNumber(),
              content: message,
            });
          }
        } catch {
          await signalInterface.send({ recipient: getOwnerNumber(), content: message });
        }
      }
    });
    initReminders();
    logger.info('Reminders initialized');
  } catch (err) {
    logger.debug('Reminders not initialized', { error: String(err) });
  }

  // Initialize Timeline event tracking
  try {
    const { addTimelineEvent } = await import('./capabilities/timeline/timeline.js');
    addTimelineEvent('system', 'system', 'Jeeves started', 'info');
    logger.info('Timeline initialized');
  } catch (err) {
    logger.debug('Timeline not initialized', { error: String(err) });
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
      try {
        const { stopUpdateChecker } = await import('./capabilities/self/updater.js');
        stopUpdateChecker();
      } catch {}
      try {
        const { stopSystemMonitor } = await import('./core/profiler/system-monitor.js');
        stopSystemMonitor();
      } catch {}
      try {
        const { stopScheduler } = await import('./capabilities/scheduler/engine.js');
        stopScheduler();
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

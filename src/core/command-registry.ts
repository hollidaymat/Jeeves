/**
 * Command Registry
 * Single source of truth for every command Jeeves can execute.
 * No regex in handler.ts. Adding a new command = adding one object here.
 */

export type CommandCategory =
  | 'system'
  | 'media'
  | 'vercel'
  | 'cursor'
  | 'homelab'
  | 'project'
  | 'notes'
  | 'schedule'
  | 'browser'
  | 'backup'
  | 'trust'
  | 'memory'
  | 'monitoring'
  | 'integrations';

export interface Command {
  id: string;
  patterns: RegExp[];
  aliases?: string[];
  action: string;
  extract?: (match: RegExpMatchArray, message: string) => Record<string, unknown>;
  examples: string[];
  category: CommandCategory;
  requiresConfirmation?: boolean;
  dangerous?: boolean;
}

export const COMMAND_REGISTRY: Command[] = [
  // --- SYSTEM ---
  {
    id: 'system.status',
    patterns: [
      /^(status|how are you|what'?s your status|system status|health|ping)$/i,
    ],
    aliases: [],
    action: 'status',
    examples: ['status', 'system status', 'health', 'ping'],
    category: 'system',
  },
  {
    id: 'system.help',
    patterns: [/^(help|\?|what can you do|commands|options|usage)$/i],
    aliases: [],
    action: 'help',
    examples: ['help', 'commands', 'what can you do'],
    category: 'system',
  },
  {
    id: 'system.cost',
    patterns: [/^(cost|costs|budget|spending|usage|how much|token usage|tokens used|daily cost)$/i],
    aliases: [],
    action: 'show_cost',
    examples: ['cost', 'costs', 'budget', 'how much'],
    category: 'system',
  },
  {
    id: 'system.builds',
    patterns: [/^(builds|build history|past builds|build report|build summary)$/i],
    aliases: [],
    action: 'show_builds',
    examples: ['builds', 'build history'],
    category: 'system',
  },
  {
    id: 'system.lessons',
    patterns: [/^(lessons|lessons learned|what.*learn|learning|improvements|anti.?patterns)$/i],
    aliases: [],
    action: 'show_lessons',
    examples: ['lessons', 'lessons learned'],
    category: 'system',
  },
  {
    id: 'system.trust',
    patterns: [/^(trust|trust status|trust level|autonomy level|what trust|show trust|my trust|autonomy)$/i],
    aliases: ['trust level', 'trust status', 'autonomy level', 'what trust', 'show trust'],
    action: 'trust_status',
    examples: ['trust', 'trust status', 'trust level', 'autonomy'],
    category: 'system',
  },
  {
    id: 'system.projects',
    patterns: [/^(list|projects|list projects|show projects|what projects|project|repo|repository|repos)$/i],
    aliases: ['project', 'repo', 'repository', 'repos'],
    action: 'list_projects',
    examples: ['list projects', 'projects', 'show projects', 'project', 'repo', 'repository'],
    category: 'system',
  },
  {
    id: 'system.jeeves_self_test',
    patterns: [
      /^(?:run\s+)?self\s*test$/i,
      /^selftest$/i,
      /^test\s+yourself$/i,
      /^how\s+are\s+you\s+doing$/i,
      /^run\s+diagnostic$/i,
      /^check\s+yourself$/i,
    ],
    aliases: ['run self test', 'self test', 'selftest', 'test yourself', 'how are you doing', 'run diagnostic', 'check yourself'],
    action: 'jeeves_self_test',
    examples: ['run self test', 'self test', 'test yourself', 'how are you doing', 'run diagnostic'],
    category: 'system',
  },

  // --- VERCEL ---
  {
    id: 'vercel.url',
    patterns: [
      /^(?:(?:can you\s+)?(?:check\s+)?vercel\s+(?:and\s+)?find\s+the\s+url\s+for\s+|vercel\s+url|vercel\s+link|url\s+(?:for|of)\s+|(?:get|send|give|show)\s+(?:me\s+)?(?:the\s+)?(?:vercel\s+)?(?:url|link)\s+(?:for|of)\s+|what'?s\s+the\s+(?:vercel\s+)?(?:url|link)\s+(?:for|of)\s+|(?:find|get)\s+(?:the\s+)?(?:vercel\s+)?(?:url|link)\s+for\s+)(.+?)$/i,
    ],
    aliases: [],
    action: 'vercel_url',
    extract: (match, _msg) => ({ target: (match[1] || '').trim().replace(/^(?:\s*(?:for|of)\s+)+/i, '').replace(/^the\s+/i, '').trim() }),
    examples: ['vercel url for sentinel', 'find the url for Sentinel', 'can you check vercel and find the url for Sentinel project'],
    category: 'vercel',
  },
  {
    id: 'vercel.deploy',
    patterns: [/^(?:deploy|vercel deploy|deploy\s+to\s+vercel|push\s+to\s+vercel|deploy\s+that\s+(?:repo|project)|ship)\s+(.+?)(?:\s+(?:to|on)\s+vercel)?$/i],
    aliases: [],
    action: 'vercel_deploy',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['deploy sentinel', 'ship dive-connect'],
    category: 'vercel',
  },
  {
    id: 'vercel.projects',
    patterns: [/^(?:vercel\s+projects|list\s+vercel|show\s+vercel|my\s+vercel|vercel\s+status|vercel)$/i],
    aliases: [],
    action: 'vercel_projects',
    examples: ['vercel projects', 'list vercel', 'vercel status'],
    category: 'vercel',
  },

  // --- CURSOR ---
  {
    id: 'cursor.status',
    patterns: [
      /^(?:cursor\s+status|what'?s\s+cursor\s+working\s+(?:on)?|cursor\s+working\s+(?:on)?|check\s+cursor|show\s+cursor)$/i,
    ],
    aliases: [],
    action: 'cursor_status',
    examples: ["cursor status", "what's cursor working on", 'check cursor'],
    category: 'cursor',
  },
  {
    id: 'cursor.launch',
    patterns: [
      /^(?:agent start|start agent|start ai|analyze|load context for|start working on|let'?s analyze)\s+(.+)$/i,
      /^(?:open in cursor|cursor open|launch|open in ide)\s+(.+)$/i,
      /^(?:cursor\s+(?:build|code|implement|work\s+on)|send\s+to\s+cursor:?\s*|have\s+cursor\s+(?:build|code|implement|work\s+on))\s+(.+)$/i,
    ],
    aliases: [],
    action: 'cursor_launch',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    requiresConfirmation: true,
    examples: ['agent start dive-connect', 'open in cursor sentinel'],
    category: 'cursor',
  },
  {
    id: 'cursor.stop',
    patterns: [/^(?:agent stop|stop agent|stop ai|close agent|end session|close(?:\s+(?:the\s+)?(?:project|session|it))?|close\s+.+)$/i],
    aliases: [],
    action: 'cursor_stop',
    examples: ['stop agent', 'close project'],
    category: 'cursor',
  },
  {
    id: 'cursor.repos',
    patterns: [/^(?:cursor\s+repos|list\s+repos|show\s+repos)$/i],
    aliases: [],
    action: 'cursor_repos',
    examples: ['cursor repos', 'list repos'],
    category: 'cursor',
  },

  // --- DEV SERVER ---
  {
    id: 'dev.start',
    patterns: [/^(?:start dev|dev start|npm run dev|start server|spin up dev)$/i],
    aliases: [],
    action: 'dev_start',
    examples: ['start dev', 'dev start', 'spin up dev'],
    category: 'system',
  },
  {
    id: 'dev.stop',
    patterns: [/^(?:stop dev|dev stop|stop server|kill dev)$/i],
    aliases: [],
    action: 'dev_stop',
    examples: ['stop dev', 'dev stop', 'kill dev'],
    category: 'system',
  },

  // --- APPLY ---
  {
    id: 'apply.last',
    patterns: [/^(?:apply(?: (?:that|this|last|it|the code|response|changes?))?|use (?:that|this) code|save (?:that|it))$/i],
    aliases: [],
    action: 'apply_last',
    examples: ['apply', 'apply that', 'use that code'],
    category: 'system',
  },

  // --- NOTES ---
  {
    id: 'notes.add',
    patterns: [/^(?:note|save|jot|write\s+down)[:\s]+(.+)$/i],
    aliases: [],
    action: 'note_add',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['note: printer IP is 192.168.7.55', 'save: fix auth tomorrow'],
    category: 'notes',
  },
  {
    id: 'notes.list',
    patterns: [/^(?:notes?|my\s+notes?|show\s+notes?|list\s+notes?)$/i],
    aliases: [],
    action: 'note_list',
    examples: ['notes', 'my notes', 'list notes'],
    category: 'notes',
  },
  {
    id: 'notes.search',
    patterns: [/^(?:find\s+note|search\s+notes?|notes?\s+about|what\s+did\s+I\s+save\s+about)\s+(.+)$/i],
    aliases: [],
    action: 'note_search',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['find note printer', 'search notes backup'],
    category: 'notes',
  },

  // --- REMINDERS ---
  {
    id: 'schedule.reminder_set',
    patterns: [/^(?:remind\s+me|reminder:?|set\s+(?:a\s+)?reminder)\s*[:\s]+(.+)/i],
    aliases: [],
    action: 'reminder_set',
    extract: (match) => ({ target: match[1]?.trim() || match[0] }),
    examples: ['remind me in 2h to check backup', 'reminder: call mom tomorrow'],
    category: 'schedule',
  },
  {
    id: 'schedule.reminder_list',
    patterns: [/^(?:reminders?|my\s+reminders?|pending\s+reminders?|show\s+reminders?|list\s+reminders?)$/i],
    aliases: [],
    action: 'reminder_list',
    examples: ['reminders', 'list reminders'],
    category: 'schedule',
  },

  // --- TIMELINE ---
  {
    id: 'monitoring.timeline',
    patterns: [/^(?:timeline|what\s+happened\s+(?:today|yesterday|recently)|event\s+log|events|activity\s+log|what'?s\s+been\s+happening)$/i],
    aliases: [],
    action: 'timeline',
    examples: ['timeline', 'what happened today', 'events'],
    category: 'monitoring',
  },

  // --- QUIET HOURS ---
  {
    id: 'schedule.quiet_hours',
    patterns: [/^(?:quiet\s+hours?|notification\s+(?:settings?|prefs?)|do\s+not\s+disturb|dnd)$/i],
    aliases: [],
    action: 'quiet_hours',
    examples: ['quiet hours', 'dnd', 'notification prefs'],
    category: 'schedule',
  },
  {
    id: 'schedule.quiet_hours_set',
    patterns: [
      /^(?:quiet\s+hours?\s+(\d{1,2}(?::\d{2})?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?)|(?:don'?t|do\s+not)\s+(?:message|notify|bother)\s+me\s+(?:between|from)\s+(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?)\s*(?:to|and|-)\s*(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?))/i,
    ],
    aliases: [],
    action: 'quiet_hours_set',
    extract: (match) => {
      const target = match[1] && match[2] ? `${match[1]}-${match[2]}` : match[3] && match[4] ? `${match[3]}-${match[4]}` : 'off';
      return { target };
    },
    examples: ['quiet hours 23:00-07:00'],
    category: 'schedule',
  },
  {
    id: 'schedule.quiet_hours_off',
    patterns: [/^(?:(?:disable|turn\s+off|stop)\s+quiet\s+hours?|notifications?\s+on|dnd\s+off)$/i],
    aliases: [],
    action: 'quiet_hours_set',
    extract: () => ({ target: 'off' }),
    examples: ['disable quiet hours', 'dnd off'],
    category: 'schedule',
  },

  // --- SCHEDULES ---
  {
    id: 'schedule.list',
    patterns: [/^(?:schedules?|my\s+schedules?|scheduled\s+tasks?|show\s+schedules?|custom\s+schedules?|list\s+schedules?)$/i],
    aliases: [],
    action: 'schedule_list',
    examples: ['schedules', 'list schedules'],
    category: 'schedule',
  },
  {
    id: 'schedule.create',
    patterns: [/^every\s+.+\s+(send|check|run|do|show|notify|test)\s+/i],
    aliases: [],
    action: 'schedule_create',
    extract: (_, msg) => ({ target: msg.trim() }),
    examples: ['every friday at 5pm send me a homelab summary'],
    category: 'schedule',
  },

  // --- HOMELAB ---
  {
    id: 'homelab.status',
    patterns: [/^(?:daemon\s+status|homelab\s+status|server\s+status|how is the server|how'?s the (?:server|daemon|box|homelab))$/i],
    aliases: [],
    action: 'homelab_status',
    examples: ['homelab status', 'daemon status', "how's the server"],
    category: 'homelab',
  },
  {
    id: 'homelab.containers',
    patterns: [/^(containers|docker ps|list containers|show containers|running containers|what'?s running)$/i],
    aliases: [],
    action: 'homelab_containers',
    examples: ['containers', 'docker ps', 'what\'s running'],
    category: 'homelab',
  },
  {
    id: 'homelab.resources',
    patterns: [/^(resources|ram|cpu|disk|memory|system resources|resource usage|how much (?:ram|memory|disk|cpu))$/i],
    aliases: [],
    action: 'homelab_resources',
    examples: ['resources', 'ram', 'disk', 'cpu'],
    category: 'homelab',
  },
  {
    id: 'homelab.temps',
    patterns: [/^(temps?|temperature|cpu temp|how hot|thermal)$/i],
    aliases: [],
    action: 'homelab_temps',
    examples: ['temps', 'temperature', 'cpu temp'],
    category: 'homelab',
  },
  {
    id: 'homelab.service_control',
    patterns: [/^(start|stop|restart)\s+(.+)$/i],
    aliases: [],
    action: 'homelab_service_restart',
    extract: (match) => {
      const verb = match[1]?.toLowerCase() || 'restart';
      const service = (match[2]?.trim() || '').toLowerCase();
      const excluded = ['dev', 'agent', 'ai', 'session', 'server', 'process'];
      if (excluded.includes(service)) return { _skip: true };
      const actionMap: Record<string, string> = {
        start: 'homelab_service_start',
        stop: 'homelab_service_stop',
        restart: 'homelab_service_restart',
      };
      return { _action: actionMap[verb] || 'homelab_service_restart', target: match[2]?.trim() || '' };
    },
    requiresConfirmation: true,
    examples: ['restart jellyfin', 'stop sonarr', 'start plex'],
    category: 'homelab',
  },
  {
    id: 'homelab.logs',
    patterns: [/^(?:logs?|show logs?|get logs?)\s+(?!errors?$)(.+)$/i],
    aliases: [],
    action: 'homelab_logs',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['logs jellyfin', 'show logs sonarr'],
    category: 'homelab',
  },
  {
    id: 'homelab.update_all',
    patterns: [/^update\s+all$/i],
    aliases: [],
    action: 'homelab_update_all',
    examples: ['update all'],
    category: 'homelab',
  },
  {
    id: 'homelab.update',
    patterns: [/^update\s+(.+)$/i],
    aliases: [],
    action: 'homelab_update',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['update jellyfin', 'update sonarr'],
    category: 'homelab',
  },
  {
    id: 'homelab.install',
    patterns: [/^install\s+(.+)$/i],
    aliases: [],
    action: 'homelab_install',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    requiresConfirmation: true,
    dangerous: true,
    examples: ['install prowlarr', 'install jellyfin'],
    category: 'homelab',
  },
  {
    id: 'homelab.uninstall',
    patterns: [/^(?:uninstall|remove)\s+(.+)$/i],
    aliases: [],
    action: 'homelab_uninstall',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    requiresConfirmation: true,
    dangerous: true,
    examples: ['uninstall jellyfin', 'remove sonarr'],
    category: 'homelab',
  },
  {
    id: 'homelab.stacks',
    patterns: [/^(stacks|docker stacks|compose stacks|list stacks|show stacks)$/i],
    aliases: [],
    action: 'homelab_stacks',
    examples: ['stacks', 'docker stacks'],
    category: 'homelab',
  },
  {
    id: 'homelab.health',
    patterns: [/^(?:daemon\s+health|homelab\s+health|health\s+check|check\s+health|service\s+health)$/i],
    aliases: [],
    action: 'homelab_health',
    examples: ['health check', 'homelab health'],
    category: 'homelab',
  },
  {
    id: 'homelab.self_test',
    patterns: [/^(self[- ]?test|run tests|test (?:all|everything|system)|diagnostics)$/i],
    aliases: [],
    action: 'homelab_self_test',
    examples: ['self-test', 'run tests', 'diagnostics'],
    category: 'homelab',
  },

  // --- MONITORING ---
  {
    id: 'monitoring.disk_health',
    patterns: [/^(?:disk\s+health|smart|smart\s+status|drive\s+health|disk\s+check|check\s+disks?)$/i],
    aliases: [],
    action: 'disk_health',
    examples: ['disk health', 'smart', 'check disks'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.docker_cleanup',
    patterns: [/^(?:docker\s+clean(?:up)?|prune|docker\s+prune|clean(?:up)?\s+docker|reclaim\s+space)$/i],
    aliases: [],
    action: 'docker_cleanup',
    requiresConfirmation: true,
    examples: ['docker cleanup', 'prune', 'docker prune'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.log_errors',
    patterns: [/^(?:errors?|log\s+errors?|container\s+errors?|show\s+errors?|recent\s+errors?)$/i],
    aliases: [],
    action: 'log_errors',
    examples: ['errors', 'log errors', 'show errors'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.pihole',
    patterns: [/^(?:pihole|pi-?hole|dns|ad\s*block|ads?\s+blocked|blocked\s+queries)$/i],
    aliases: [],
    action: 'pihole_stats',
    examples: ['pihole', 'dns', 'ads blocked'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.speed_test',
    patterns: [/^(?:speed\s*test|internet\s+speed|bandwidth\s+test|test\s+speed|how\s+fast|connection\s+speed)$/i],
    aliases: [],
    action: 'speed_test',
    examples: ['speed test', 'internet speed'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.image_updates',
    patterns: [/^(?:image\s+updates?|container\s+updates?|check\s+updates?|available\s+updates?|outdated\s+(?:images?|containers?))$/i],
    aliases: [],
    action: 'image_updates',
    examples: ['image updates', 'check updates'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.ssl_check',
    patterns: [/^(?:ssl|ssl\s+check|cert(?:s|ificates?)?|ssl\s+status|tls|cert\s+expiry|check\s+certs?)$/i],
    aliases: [],
    action: 'ssl_check',
    examples: ['ssl check', 'certs', 'cert expiry'],
    category: 'monitoring',
  },
  {
    id: 'monitoring.service_deps',
    patterns: [
      /^(?:dep(?:s|endenc(?:y|ies))\s+(?:for\s+)?(.+)|what\s+depends\s+on\s+(.+)|(.+)\s+dependencies|if\s+(.+)\s+(?:goes?\s+down|dies|crashes))$/i,
    ],
    aliases: [],
    action: 'service_deps',
    extract: (match) => {
      const target = (match[1] || match[2] || match[3] || match[4] || '').trim();
      return { target };
    },
    examples: ['deps for postgres', 'what depends on sonarr'],
    category: 'monitoring',
  },

  // --- MEDIA ---
  {
    id: 'media.status',
    patterns: [
      /^(?:download(?:s|ing)?|queue|what'?s downloading|download status|download queue|media status|media queue)$/i,
      /^(?:check|get|show|what'?s?)\s+(?:downloads?|queue|download\s+(?:status|queue)|media\s+(?:status|queue))$/i,
      /^(?:what(?:'?s)?\s+)?(?:are\s+)?(?:my\s+)?downloads?$/i,
    ],
    aliases: [],
    action: 'media_status',
    examples: ['downloads', 'check downloads', 'queue', 'download status'],
    category: 'media',
  },
  {
    id: 'media.search',
    patterns: [/^(?:search|find|look\s*up|search\s+for)\s+(.+)/i],
    aliases: [],
    action: 'media_search',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['search inception', 'find breaking bad'],
    category: 'media',
  },
  {
    id: 'media.download',
    patterns: [/^(?:download|get|grab|add|queue)\s+(.+)/i],
    aliases: [],
    action: 'media_download',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['download inception', 'get breaking bad season 2'],
    category: 'media',
  },

  // --- INTEGRATIONS ---
  {
    id: 'integrations.tailscale',
    patterns: [/^(?:tailscale|vpn|vpn\s+status|tailscale\s+status|who'?s\s+connected|connected\s+devices)$/i],
    aliases: [],
    action: 'tailscale_status',
    examples: ['tailscale', 'vpn status', 'who\'s connected'],
    category: 'integrations',
  },
  {
    id: 'integrations.nextcloud',
    patterns: [/^(?:nextcloud|nextcloud\s+status|nextcloud\s+storage|cloud\s+storage)$/i],
    aliases: [],
    action: 'nextcloud_status',
    examples: ['nextcloud', 'nextcloud status'],
    category: 'integrations',
  },
  {
    id: 'integrations.grafana',
    patterns: [/^(?:grafana|grafana\s+(?:dashboards?|status)|show\s+grafana)$/i],
    aliases: [],
    action: 'grafana_dashboards',
    examples: ['grafana', 'show grafana'],
    category: 'integrations',
  },
  {
    id: 'integrations.uptime_kuma',
    patterns: [/^(?:uptime(?:\s+kuma)?|monitors?|uptime\s+status|service\s+uptime|is\s+.+\s+up\??)$/i],
    aliases: [],
    action: 'uptime_kuma',
    examples: ['uptime', 'monitors', 'uptime kuma'],
    category: 'integrations',
  },
  {
    id: 'integrations.bandwidth',
    patterns: [/^(?:bandwidth|network\s+usage|net\s+usage|who'?s\s+(?:using|eating)\s+bandwidth)$/i],
    aliases: [],
    action: 'bandwidth',
    examples: ['bandwidth', 'network usage'],
    category: 'integrations',
  },
  {
    id: 'integrations.qbittorrent',
    patterns: [/^(?:qbittorrent|qbit|qbit\s+status|torrent\s+status|qbit\s+torrents|qbit\s+list)$/i],
    aliases: [],
    action: 'qbittorrent_status',
    examples: ['qbittorrent', 'qbit status', 'add torrent <magnet link>'],
    category: 'integrations',
  },
  {
    id: 'integrations.home_assistant',
    patterns: [
      /^(?:(?:indoor?\s+)?temp(?:erature)?s?\s*(?:inside)?|how\s+(?:hot|cold|warm)\s+is\s+it\s+inside|what'?s\s+the\s+temp(?:erature)?\s+inside)$/i,
      /^(?:(?:turn\s+)?(?:on|off)\s+(?:the\s+)?(.+?)\s*(?:lights?)?|(?:lights?)\s+(?:on|off))$/i,
      /^(?:ha|home\s*assistant)\s+(.+)$/i,
    ],
    aliases: [],
    action: 'home_assistant',
    extract: (match, msg) => ({ target: match[1]?.trim() || msg.trim() }),
    examples: ['indoor temperature', 'lights off', 'ha status'],
    category: 'integrations',
  },

  // --- FILE SHARE ---
  {
    id: 'file.share',
    patterns: [/^(?:send\s+(?:me\s+)?(?:the\s+)?(?:file\s+)?|share\s+(?:file\s+)?)(.+?)(?:\s+file)?$/i],
    aliases: [],
    action: 'file_share',
    extract: (match) => ({ target: match[1]?.trim() || '' }),
    examples: ['send me /opt/stacks/jellyfin/docker-compose.yml'],
    category: 'system',
  },
];

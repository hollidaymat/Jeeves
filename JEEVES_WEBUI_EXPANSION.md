# Jeeves Web UI Expansion

## Design Mandate

Keep existing cyberpunk-operator aesthetic. Dark (#0c0c14), cyan (#22d3ee), purple (#a855f7), glow effects. All new panels follow existing card/border/font patterns. No new colors, no new fonts.

---

## 1. Service Deep Dive Panels

### Current State
Service cards show name + RAM usage with green/red/yellow dots.

### New Behavior
Click a service card → expands inline (no navigation, no new page) → shows live details.

### Panel Content Per Service Type

**Media Services (Jellyfin, Radarr, Sonarr, Lidarr, Prowlarr, Bazarr):**
```javascript
{
  // Jellyfin
  "activeStreams": 2,
  "transcoding": true,
  "librarySize": { "movies": 847, "shows": 123 },
  "recentlyAdded": [{ "title": "Dune Part Two", "added": "2h ago" }],
  "diskUsage": "234GB / 512GB"
}

{
  // Radarr/Sonarr
  "queue": [
    { "title": "Movie Name", "status": "downloading", "progress": 67, "eta": "12m" },
    { "title": "Movie 2", "status": "queued", "position": 2 }
  ],
  "monitored": 142,
  "missing": 8,
  "diskSpace": "234GB free",
  "lastGrab": "The Wild Robot - 4h ago",
  "health": [{ "type": "warning", "message": "Indexer X responded slowly" }]
}

{
  // Prowlarr
  "indexers": [
    { "name": "Indexer1", "status": "healthy", "queries24h": 47 },
    { "name": "Indexer2", "status": "warning", "error": "Rate limited" }
  ],
  "totalGrabs24h": 12
}
```

**Infrastructure Services (Pi-hole, Uptime Kuma, Prometheus, Grafana):**
```javascript
{
  // Pi-hole
  "queriesTotal": 48293,
  "queriesBlocked": 12847,
  "blockPercent": 26.6,
  "topBlocked": ["ads.google.com", "tracker.facebook.com"],
  "topClients": [{ "ip": "192.168.1.20", "queries": 4200 }],
  "status": "enabled"
}

{
  // Uptime Kuma
  "monitors": [
    { "name": "Jellyfin", "status": "up", "uptime30d": 99.8, "ping": "2ms" },
    { "name": "Nextcloud", "status": "up", "uptime30d": 98.2, "ping": "14ms" },
    { "name": "Portfolio Site", "status": "down", "downSince": "10m ago" }
  ],
  "overallUptime": 99.1
}
```

**Storage Services (Nextcloud, Paperless-ngx, Vaultwarden):**
```javascript
{
  // Nextcloud
  "users": 1,
  "storageUsed": "42GB / 200GB",
  "recentFiles": ["project-spec.pdf", "taxes-2025.xlsx"],
  "appsInstalled": 12,
  "pendingUpdates": 2
}

{
  // Paperless-ngx
  "documentsTotal": 847,
  "documentsThisMonth": 23,
  "recentDocuments": ["Electric Bill Jan 2026", "W2 2025"],
  "storageUsed": "2.1GB",
  "pendingOCR": 0
}
```

### Implementation

```javascript
// src/api/services.js
// Each service type has a collector that queries its API

const collectors = {
  jellyfin: {
    endpoint: 'http://localhost:8096',
    apiKey: process.env.JELLYFIN_API_KEY,
    async collect() {
      const sessions = await this.get('/Sessions');
      const library = await this.get('/Library/MediaFolders');
      const recent = await this.get('/Items/Latest');
      return {
        activeStreams: sessions.filter(s => s.NowPlayingItem).length,
        transcoding: sessions.some(s => s.TranscodingInfo),
        librarySize: this.countLibrary(library),
        recentlyAdded: recent.slice(0, 5),
        diskUsage: await this.getDiskUsage()
      };
    }
  },

  radarr: {
    endpoint: 'http://localhost:7878',
    apiKey: process.env.RADARR_API_KEY,
    async collect() {
      const queue = await this.get('/api/v3/queue');
      const movies = await this.get('/api/v3/movie');
      const health = await this.get('/api/v3/health');
      const disk = await this.get('/api/v3/diskspace');
      return {
        queue: queue.records.map(r => ({
          title: r.title,
          status: r.status,
          progress: Math.round((1 - r.sizeleft / r.size) * 100),
          eta: r.estimatedCompletionTime
        })),
        monitored: movies.filter(m => m.monitored).length,
        missing: movies.filter(m => m.monitored && !m.hasFile).length,
        diskSpace: this.formatDisk(disk),
        health: health
      };
    }
  },

  pihole: {
    endpoint: 'http://localhost:80',
    apiKey: process.env.PIHOLE_API_KEY,
    async collect() {
      const summary = await this.get('/admin/api.php?summaryRaw');
      const topBlocked = await this.get('/admin/api.php?topItems&auth=' + this.apiKey);
      return {
        queriesTotal: summary.dns_queries_today,
        queriesBlocked: summary.ads_blocked_today,
        blockPercent: parseFloat(summary.ads_percentage_today),
        topBlocked: Object.keys(topBlocked.top_ads || {}).slice(0, 5),
        status: summary.status
      };
    }
  },

  uptimekuma: {
    endpoint: 'http://localhost:3001',
    async collect() {
      // Uses push API or socket connection
      const monitors = await this.getMonitors();
      return {
        monitors: monitors.map(m => ({
          name: m.name,
          status: m.active ? 'up' : 'down',
          uptime30d: m.uptime30d,
          ping: m.ping + 'ms'
        })),
        overallUptime: this.calcOverall(monitors)
      };
    }
  }
};

// Polling: collect every 30s, cache results
// WebSocket push to dashboard on change
```

### UI Behavior

```
COLLAPSED (current):
┌─────────────────────────────┐
│ ● jellyfin          318MB   │
└─────────────────────────────┘

EXPANDED (click):
┌─────────────────────────────────────────────────┐
│ ● jellyfin          318MB              [collapse]│
│─────────────────────────────────────────────────│
│ STREAMS: 2 active (1 transcoding)               │
│ LIBRARY: 847 movies · 123 shows                 │
│ DISK: 234GB / 512GB ████████████░░░ 46%         │
│                                                  │
│ RECENTLY ADDED:                                  │
│  Dune Part Two ................... 2h ago        │
│  The Wild Robot .................. 1d ago        │
│  Nosferatu ....................... 3d ago        │
│                                                  │
│ HEALTH: All systems normal                       │
└─────────────────────────────────────────────────┘
```

Animation: slide-down expand, 200ms ease-out. Cyan border glow on expanded card.

---

## 2. Jeeves Activity Panel

### Current State
Command console shows recent messages. No visibility into scheduled work, active tasks, or autonomy.

### New Panel: JEEVES ACTIVITY

```
┌──────────────────────────────────────────────────────┐
│ JEEVES ACTIVITY                              [pause] │
│──────────────────────────────────────────────────────│
│                                                      │
│ CURRENT TASK                                         │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Installing Bazarr stack                          │ │
│ │ Phase 2/3: Configuring subtitle providers        │ │
│ │ ████████████████░░░░░░░░ 65%                     │ │
│ │ Started: 1:36 PM · Est. complete: 1:42 PM        │ │
│ │ Cost so far: $0.003                              │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ QUEUE (2)                                            │
│  1. Configure Radarr quality profiles     [pending]  │
│  2. Run weekly backup                     [scheduled]│
│                                                      │
│ STANDING ORDERS                                      │
│  ● Monitor container health        every 60s  [active]│
│  ● Check disk space                every 1h   [active]│
│  ● Backup configs                  daily 3am  [active]│
│  ● Update containers               weekly sun [active]│
│                                                      │
│ SCHEDULED                                            │
│  Today 3:00 AM    Backup configs to /mnt/backup      │
│  Tomorrow 2:00 AM Update container images             │
│  Sun 4:00 AM      Full system health report           │
│                                                      │
│ RECENT (last 24h)                                    │
│  ✓ Installed prowlarr             1:36 PM   $0.001   │
│  ✓ DNS entry added                1:36 PM   $0.000   │
│  ✓ Container health check         1:30 PM   $0.000   │
│  ✓ Disk space check               1:00 PM   $0.000   │
│  ✗ Sonarr webhook failed          12:45 PM  $0.001   │
│    └─ Retried successfully        12:46 PM           │
│                                                      │
│ TODAY: 47 tasks · $0.014 spent · 0 failures          │
└──────────────────────────────────────────────────────┘
```

### Data Model

```javascript
// src/models/activity.js
const activitySchema = {
  currentTask: {
    id: String,
    name: String,
    phase: Number,
    totalPhases: Number,
    progress: Number,        // 0-100
    startedAt: Date,
    estimatedComplete: Date,
    cost: Number
  },
  queue: [{
    id: String,
    name: String,
    status: 'pending' | 'scheduled',
    scheduledFor: Date,      // null if pending
    priority: Number
  }],
  standingOrders: [{
    id: String,
    name: String,
    interval: String,        // cron expression
    lastRun: Date,
    nextRun: Date,
    status: 'active' | 'paused' | 'error',
    successRate: Number      // last 30 days
  }],
  history: [{
    id: String,
    name: String,
    completedAt: Date,
    status: 'success' | 'failed' | 'retried',
    cost: Number,
    tokensUsed: Number,
    duration: Number,        // ms
    error: String            // null if success
  }]
};
```

### WebSocket Events

```javascript
// Real-time updates from Jeeves to dashboard
const events = {
  'task:started':    { task, estimatedDuration },
  'task:progress':   { taskId, phase, progress, cost },
  'task:completed':  { taskId, result, cost, duration },
  'task:failed':     { taskId, error, willRetry },
  'queue:updated':   { queue },
  'cron:executed':   { orderId, result },
  'cost:updated':    { daily, weekly, monthly }
};
```

---

## 3. Project Tracker

### Purpose
Visual board for your active projects. Jeeves tracks progress, you see what's left.

### Layout: Kanban-style columns

```
┌──────────────────────────────────────────────────────────────────┐
│ PROJECTS                                          [+ New Project]│
│──────────────────────────────────────────────────────────────────│
│                                                                  │
│  Jeeves v2                    Dive Management         Portfolio  │
│  ████████████░░░ 72%          ██████░░░░░░░ 45%       ██░░░░ 15%│
│                                                                  │
│ ┌──────────────┬──────────────┬──────────────┬──────────────┐   │
│ │ BACKLOG (4)  │ IN PROGRESS  │ REVIEW (1)   │ DONE (8)     │   │
│ │              │ (2)          │              │              │   │
│ │ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐ │   │
│ │ │ Signal   │ │ │ 6-Layer  │ │ │ Parser   │ │ │ Web UI   │ │   │
│ │ │ integr.  │ │ │ Context  │ │ │ improve  │ │ │ v1       │ │   │
│ │ │          │ │ │          │ │ │          │ │ │          │ │   │
│ │ │ P1 · 3pts│ │ │ P1 · 5pts│ │ │ P2 · 3pts│ │ │ ✓ 5pts  │ │   │
│ │ └──────────┘ │ └──────────┘ │ └──────────┘ │ └──────────┘ │   │
│ │ ┌──────────┐ │ ┌──────────┐ │              │ ┌──────────┐ │   │
│ │ │ Matrix   │ │ │ Homelab  │ │              │ │ Docker   │ │   │
│ │ │ interf.  │ │ │ ops      │ │              │ │ stack    │ │   │
│ │ │          │ │ │          │ │              │ │          │ │   │
│ │ │ P3 · 5pts│ │ │ P1 · 8pts│ │              │ │ ✓ 8pts  │ │   │
│ │ └──────────┘ │ └──────────┘ │              │ └──────────┘ │   │
│ └──────────────┴──────────────┴──────────────┴──────────────┘   │
│                                                                  │
│ VELOCITY: 12 pts/week · Est. completion: Mar 15                  │
└──────────────────────────────────────────────────────────────────┘
```

### Data Model

```javascript
// src/models/projects.js
const projectSchema = {
  id: String,
  name: String,
  description: String,
  createdAt: Date,
  tasks: [{
    id: String,
    title: String,
    description: String,
    status: 'backlog' | 'in_progress' | 'review' | 'done',
    priority: 'P1' | 'P2' | 'P3',
    points: Number,          // complexity estimate
    assignee: 'jeeves' | 'you' | 'cursor',
    createdAt: Date,
    completedAt: Date,
    linkedCommits: [String], // git SHAs
    linkedFiles: [String]    // files touched
  }],
  // Computed
  progress: Number,          // 0-100 based on points done/total
  velocity: Number,          // points per week
  estimatedCompletion: Date
};
```

### Jeeves Integration

Jeeves can:
- Auto-create tasks from PRDs he receives
- Move tasks to "in_progress" when he starts working
- Move to "done" when complete, link commits
- Report blockers
- Calculate velocity from history

```javascript
// Commands
"show projects"          → Project overview
"add task to Jeeves v2: implement Signal interface"
"what's left on Dive Management?"
"move parser improvements to done"
```

### Interaction

- Drag-and-drop cards between columns
- Click card → expand with description, linked commits, files
- Project selector tabs at top
- Progress bar per project with point-based calculation
- Velocity chart (points/week over time)

---

## 4. Vercel Website Stats

### Setup

Requires Vercel API token with read access.

```javascript
// config.json
{
  "vercel": {
    "apiToken": "${VERCEL_API_TOKEN}",
    "teamId": null,          // null for personal
    "projects": [
      { "name": "portfolio", "id": "prj_xxx" },
      { "name": "dive-management", "id": "prj_yyy" }
    ],
    "pollInterval": 300000   // 5 minutes
  }
}
```

### Vercel API Endpoints Used

```javascript
// src/api/vercel.js
const vercelCollector = {
  baseUrl: 'https://api.vercel.com',
  
  async collectProject(project) {
    const [deployments, domains, analytics] = await Promise.all([
      this.get(`/v6/deployments?projectId=${project.id}&limit=5`),
      this.get(`/v9/projects/${project.id}/domains`),
      this.getAnalytics(project.id)
    ]);

    return {
      name: project.name,
      production: {
        url: deployments.deployments[0]?.url,
        status: deployments.deployments[0]?.readyState,
        deployedAt: deployments.deployments[0]?.created,
        commitMessage: deployments.deployments[0]?.meta?.githubCommitMessage
      },
      recentDeploys: deployments.deployments.map(d => ({
        status: d.readyState,
        created: d.created,
        duration: d.buildingAt ? d.ready - d.buildingAt : null,
        commit: d.meta?.githubCommitMessage?.substring(0, 50)
      })),
      domains: domains.domains.map(d => d.name),
      analytics: analytics
    };
  },

  async getAnalytics(projectId) {
    // Web Analytics API (requires Vercel Analytics enabled)
    const now = Date.now();
    const dayAgo = now - 86400000;
    const weekAgo = now - 604800000;

    const [daily, weekly] = await Promise.all([
      this.get(`/v1/web/insights?projectId=${projectId}&from=${dayAgo}&to=${now}`),
      this.get(`/v1/web/insights?projectId=${projectId}&from=${weekAgo}&to=${now}`)
    ]);

    return {
      today: {
        visitors: daily?.visitors || 'N/A',
        pageViews: daily?.pageViews || 'N/A',
        topPages: daily?.topPages?.slice(0, 5) || []
      },
      thisWeek: {
        visitors: weekly?.visitors || 'N/A',
        pageViews: weekly?.pageViews || 'N/A',
        topReferrers: weekly?.topReferrers?.slice(0, 5) || []
      }
    };
  }
};
```

### Dashboard Panel

```
┌──────────────────────────────────────────────────────────────────┐
│ VERCEL SITES                                          [refresh] │
│──────────────────────────────────────────────────────────────────│
│                                                                  │
│ portfolio                                     dive-management    │
│ portfolio.vercel.app                          diveapp.vercel.app │
│ ● LIVE                                        ● LIVE             │
│                                                                  │
│ ┌────────────────────────────┐ ┌────────────────────────────┐   │
│ │ TODAY        THIS WEEK     │ │ TODAY        THIS WEEK     │   │
│ │ 142 visits   1,247 visits  │ │ 38 visits    284 visits    │   │
│ │ 310 views    3,891 views   │ │ 95 views     712 views     │   │
│ │                            │ │                            │   │
│ │ TOP PAGES                  │ │ TOP PAGES                  │   │
│ │  /           98 views      │ │  /dashboard   42 views     │   │
│ │  /projects   67 views      │ │  /login       31 views     │   │
│ │  /about      45 views      │ │  /sites       22 views     │   │
│ │                            │ │                            │   │
│ │ RECENT DEPLOYS             │ │ RECENT DEPLOYS             │   │
│ │  ✓ "fix nav links" 2h ago  │ │  ✓ "add charts" 1d ago    │   │
│ │  ✓ "add blog"      1d ago  │ │  ✗ "broken build" 2d ago  │   │
│ │  ✓ "update hero"   3d ago  │ │  ✓ "fix types"    2d ago  │   │
│ │                            │ │                            │   │
│ │ BUILD TIME: 34s avg        │ │ BUILD TIME: 48s avg        │   │
│ └────────────────────────────┘ └────────────────────────────┘   │
│                                                                  │
│ TOTAL: 180 visitors today · 1,531 this week · 2 sites healthy    │
└──────────────────────────────────────────────────────────────────┘
```

### Vercel Commands via Jeeves

```
"how are my sites doing?"     → Summary of all projects
"deploy portfolio"            → Trigger deployment via API
"what broke on dive app?"     → Show last failed deploy + error logs
"show me traffic this week"   → Analytics summary
```

---

## 5. Cost Dashboard (Enhanced)

### Current State
Inline cost in console logs.

### New Panel

```
┌──────────────────────────────────────────────────────────────────┐
│ COST CENTER                                                      │
│──────────────────────────────────────────────────────────────────│
│                                                                  │
│ TODAY              THIS WEEK           THIS MONTH                │
│ $0.014             $0.89               $3.42                     │
│ /$5.00 limit       /$25.00 limit       /$75.00 limit            │
│ ░░░░░░░░░░ 0.3%   ███░░░░░░░ 3.6%    ████░░░░░░ 4.6%          │
│                                                                  │
│ BY MODEL                    BY CATEGORY                          │
│  Haiku:   $0.004 (29%)      Commands:    $0.003                  │
│  Sonnet:  $0.010 (71%)      Installs:    $0.008                  │
│  Opus:    $0.000 (0%)       Monitoring:  $0.001                  │
│                              Coding:     $0.002                  │
│                                                                  │
│ TREND: ▼ 12% vs last week                                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Navigation

Current UI is single-page. Add tab navigation to manage new panels.

```
┌─────────────────────────────────────────────────────────────────┐
│ JEEVES   ● CONNECTED                        UPTIME: 12:34:56   │
│─────────────────────────────────────────────────────────────────│
│ [CONSOLE] [HOMELAB] [ACTIVITY] [PROJECTS] [SITES] [COSTS]      │
│─────────────────────────────────────────────────────────────────│
│                                                                  │
│ ... active tab content ...                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

- CONSOLE: Current command interface + system status sidebar
- HOMELAB: Service cards with expandable deep-dive panels
- ACTIVITY: Jeeves task tracker, queue, standing orders, crons
- PROJECTS: Kanban boards per project
- SITES: Vercel stats for all projects
- COSTS: Budget dashboard

Tab styling: inactive = dim cyan text, active = bright cyan with underline glow.

---

## Implementation Order

1. **Navigation tabs** - Structural change, do first
2. **Service deep-dive panels** - Highest daily value
3. **Jeeves Activity panel** - Visibility into what he's doing
4. **Cost dashboard** - Already have data, just needs UI
5. **Project tracker** - New data model, more work
6. **Vercel stats** - Needs API token setup, do last

## Dependencies

- Service APIs need API keys configured per service
- Vercel needs `VERCEL_API_TOKEN` (Settings > Tokens > Create)
- WebSocket events need server-side emission on task state changes
- Project data needs persistence (JSON file or SQLite)

# Jeeves Homelab Capabilities - Build Guide for Cursor

## Context

Jeeves runs on a Beelink Mini S13 (Intel N150, 16GB DDR4, 512GB SSD) with Ubuntu Server 24.04 LTS.
This document tells Cursor how to build homelab management capabilities into Jeeves.
Jeeves must be able to install, configure, monitor, troubleshoot, and maintain all services listed below.

## Hardware Constraints

- **CPU:** Intel N150 (4 E-cores, 3.6GHz burst) - efficient, not powerful
- **RAM:** 16GB DDR4 - tight budget, every MB matters
- **Storage:** 512GB SSD - OS + containers + configs. Media goes on external/NAS
- **Network:** 1Gbps LAN, WiFi 6
- **GPU:** Intel UHD (supports hardware transcoding via QuickSync)
- **Power:** ~15W TDP - runs 24/7 cheaply

**Hard rule:** Never exceed 14GB RAM usage. Reserve 2GB for OS + Jeeves.

---

## Architecture: Everything in Docker

No bare-metal installs except Docker itself and Jeeves. Every service runs containerized.

### Required Base System (Cursor must build these capabilities into Jeeves)

```
src/homelab/
├── docker/
│   ├── compose-manager.js    # Generate, validate, deploy docker-compose files
│   ├── container-monitor.js  # Health checks, restart policies, resource usage
│   └── image-manager.js      # Pull, update, prune images
├── system/
│   ├── systemd-manager.js    # Create/manage systemd services
│   ├── resource-monitor.js   # CPU, RAM, disk, temp, network
│   ├── package-manager.js    # apt operations
│   ├── user-manager.js       # Users, permissions, groups
│   └── cron-manager.js       # Scheduled tasks
├── network/
│   ├── firewall.js           # UFW rule management
│   ├── reverse-proxy.js      # Nginx/Traefik config generation
│   ├── dns.js                # DNS management, Cloudflare API
│   ├── vpn.js                # Tailscale/WireGuard setup
│   └── ssl.js                # Let's Encrypt cert management
├── security/
│   ├── ssh-hardening.js      # SSH config, key management, fail2ban
│   ├── audit.js              # Log analysis, intrusion detection
│   └── backup-security.js    # Encrypted backup verification
├── backup/
│   ├── restic-manager.js     # Restic backup orchestration
│   ├── snapshot-manager.js   # LVM snapshots
│   └── restore-manager.js    # Disaster recovery procedures
├── services/
│   ├── registry.js           # Master list of all services, ports, dependencies
│   ├── health-checker.js     # Per-service health verification
│   └── updater.js            # Watchtower or manual update orchestration
└── templates/
    ├── docker-compose/       # Pre-built compose templates per service
    └── configs/              # Default config files per service
```

---

## Service Registry

Jeeves must maintain a registry of all services with their state, ports, dependencies, and resource allocation.

```javascript
// src/homelab/services/registry.js

const SERVICE_REGISTRY = {
  // TIER 1: Core Infrastructure (always running)
  core: {
    portainer: {
      image: 'portainer/portainer-ce:latest',
      ports: [9000, 9443],
      ram: '64MB',
      purpose: 'Docker management UI',
      priority: 'critical',
      depends: []
    },
    traefik: {
      image: 'traefik:v3.0',
      ports: [80, 443, 8080],
      ram: '64MB',
      purpose: 'Reverse proxy, SSL termination',
      priority: 'critical',
      depends: []
    },
    pihole: {
      image: 'pihole/pihole:latest',
      ports: [53, 8053],
      ram: '128MB',
      purpose: 'DNS blocking, local DNS',
      priority: 'critical',
      depends: []
    },
    tailscale: {
      type: 'system-service',
      ram: '32MB',
      purpose: 'VPN mesh network',
      priority: 'critical',
      depends: []
    }
  },

  // TIER 2: Media Stack
  media: {
    jellyfin: {
      image: 'jellyfin/jellyfin:latest',
      ports: [8096],
      ram: '512MB',
      purpose: 'Media server (hardware transcoding via QuickSync)',
      priority: 'high',
      depends: [],
      devices: ['/dev/dri:/dev/dri']  // GPU passthrough for transcoding
    },
    sonarr: {
      image: 'lscr.io/linuxserver/sonarr:latest',
      ports: [8989],
      ram: '256MB',
      purpose: 'TV show management',
      priority: 'medium',
      depends: ['prowlarr']
    },
    radarr: {
      image: 'lscr.io/linuxserver/radarr:latest',
      ports: [7878],
      ram: '256MB',
      purpose: 'Movie management',
      priority: 'medium',
      depends: ['prowlarr']
    },
    prowlarr: {
      image: 'lscr.io/linuxserver/prowlarr:latest',
      ports: [9696],
      ram: '128MB',
      purpose: 'Indexer management',
      priority: 'medium',
      depends: []
    },
    lidarr: {
      image: 'lscr.io/linuxserver/lidarr:latest',
      ports: [8686],
      ram: '256MB',
      purpose: 'Music management',
      priority: 'low',
      depends: ['prowlarr']
    },
    bazarr: {
      image: 'lscr.io/linuxserver/bazarr:latest',
      ports: [6767],
      ram: '128MB',
      purpose: 'Subtitle management',
      priority: 'low',
      depends: ['sonarr', 'radarr']
    },
    overseerr: {
      image: 'lscr.io/linuxserver/overseerr:latest',
      ports: [5055],
      ram: '128MB',
      purpose: 'Media request management',
      priority: 'low',
      depends: ['jellyfin', 'sonarr', 'radarr']
    },
    tautulli: {
      image: 'lscr.io/linuxserver/tautulli:latest',
      ports: [8181],
      ram: '128MB',
      purpose: 'Media server analytics',
      priority: 'low',
      depends: ['jellyfin']
    }
  },

  // TIER 3: Self-Hosted Services
  services: {
    nextcloud: {
      image: 'nextcloud:latest',
      ports: [8443],
      ram: '512MB',
      purpose: 'Files, calendar, contacts',
      priority: 'high',
      depends: ['postgres']
    },
    vaultwarden: {
      image: 'vaultwarden/server:latest',
      ports: [8843],
      ram: '64MB',
      purpose: 'Password manager',
      priority: 'critical',
      depends: []
    },
    paperless: {
      image: 'ghcr.io/paperless-ngx/paperless-ngx:latest',
      ports: [8000],
      ram: '512MB',
      purpose: 'Document management',
      priority: 'medium',
      depends: ['postgres', 'redis']
    },
    homeassistant: {
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      ports: [8123],
      ram: '512MB',
      purpose: 'Home automation',
      priority: 'high',
      depends: [],
      networkMode: 'host'
    }
  },

  // TIER 4: Databases
  databases: {
    postgres: {
      image: 'postgres:16-alpine',
      ports: [5432],
      ram: '256MB',
      purpose: 'Primary database',
      priority: 'critical',
      depends: []
    },
    redis: {
      image: 'redis:7-alpine',
      ports: [6379],
      ram: '64MB',
      purpose: 'Cache, message broker',
      priority: 'high',
      depends: []
    }
  },

  // TIER 5: Monitoring
  monitoring: {
    uptime_kuma: {
      image: 'louislam/uptime-kuma:latest',
      ports: [3001],
      ram: '128MB',
      purpose: 'Service uptime monitoring',
      priority: 'high',
      depends: []
    },
    prometheus: {
      image: 'prom/prometheus:latest',
      ports: [9090],
      ram: '256MB',
      purpose: 'Metrics collection',
      priority: 'medium',
      depends: []
    },
    grafana: {
      image: 'grafana/grafana:latest',
      ports: [3000],
      ram: '128MB',
      purpose: 'Metrics dashboards',
      priority: 'medium',
      depends: ['prometheus']
    },
    node_exporter: {
      image: 'prom/node-exporter:latest',
      ports: [9100],
      ram: '32MB',
      purpose: 'Hardware metrics export',
      priority: 'medium',
      depends: []
    }
  }
};

// TOTAL RAM ESTIMATE (all services):
// Core: ~288MB
// Media: ~1,792MB
// Services: ~1,588MB
// Databases: ~320MB
// Monitoring: ~544MB
// TOTAL: ~4,532MB (~4.4GB)
// OS + Jeeves: ~2GB
// HEADROOM: ~9.5GB free
// 
// VERDICT: All services fit. Comfortably.
```

---

## Docker Compose Generation

Jeeves must generate, validate, and deploy compose files. Not store one giant file - modular stacks.

```javascript
// src/homelab/docker/compose-manager.js

class ComposeManager {
  // Generate compose file for a service stack
  async generateCompose(stackName, services) {
    const compose = {
      version: '3.8',
      services: {},
      networks: { proxy: { external: true } },
      volumes: {}
    };

    for (const svc of services) {
      const def = this.getServiceDefinition(svc);
      compose.services[svc] = {
        image: def.image,
        container_name: svc,
        restart: 'unless-stopped',
        ports: def.ports.map(p => `${p}:${p}`),
        volumes: this.getVolumes(svc),
        environment: this.getEnvVars(svc),
        labels: this.getTraefikLabels(svc),
        deploy: {
          resources: {
            limits: { memory: def.ram }
          }
        }
      };

      if (def.devices) compose.services[svc].devices = def.devices;
      if (def.networkMode) compose.services[svc].network_mode = def.networkMode;
    }

    return compose;
  }

  // Validate compose before deploying
  async validate(composeFile) {
    // Check port conflicts
    // Check volume paths exist
    // Check image availability
    // Check RAM total vs available
    // Check dependency order
  }

  // Deploy a stack
  async deploy(stackName) {
    const composePath = `/opt/stacks/${stackName}/docker-compose.yml`;
    await exec(`docker compose -f ${composePath} up -d`);
    await this.healthCheck(stackName);
  }
}
```

---

## Resource Monitor

Jeeves must track system resources and make decisions about what to start/stop.

```javascript
// src/homelab/system/resource-monitor.js

class ResourceMonitor {
  async getStatus() {
    return {
      cpu: await this.getCPU(),        // Usage %, temp, load average
      ram: await this.getRAM(),        // Used, free, per-container
      disk: await this.getDisk(),      // Usage per mount, I/O rates
      network: await this.getNetwork(),// Bandwidth, connections
      containers: await this.getContainerStats(), // Per-container CPU/RAM
      temperature: await this.getTemp()  // CPU temp (important for mini PC)
    };
  }

  // Alert thresholds
  thresholds = {
    cpu: { warning: 80, critical: 95 },
    ram: { warning: 85, critical: 95 },  // 14GB of 16GB
    disk: { warning: 80, critical: 90 },
    temp: { warning: 75, critical: 85 }  // N150 throttles at ~90C
  };

  // Auto-actions when thresholds hit
  async handleThreshold(metric, level) {
    if (level === 'critical') {
      // Stop low-priority containers
      const lowPriority = this.registry.getByPriority('low');
      for (const svc of lowPriority) {
        await this.docker.stop(svc);
        this.notify(`Stopped ${svc} - ${metric} critical`);
      }
    }
    if (level === 'warning') {
      this.notify(`${metric} at warning level`);
    }
  }
}
```

---

## Network Security Stack

```javascript
// src/homelab/network/firewall.js

const DEFAULT_RULES = {
  // Block everything inbound except:
  allow: [
    { port: 22, from: 'LAN', proto: 'tcp', comment: 'SSH from LAN only' },
    { port: 53, from: 'LAN', proto: 'both', comment: 'Pi-hole DNS' },
    { port: 80, from: 'any', proto: 'tcp', comment: 'HTTP (Traefik redirect)' },
    { port: 443, from: 'any', proto: 'tcp', comment: 'HTTPS (Traefik)' },
    { port: 41641, from: 'any', proto: 'udp', comment: 'Tailscale' }
  ],
  // Everything else: DENY
  defaultInbound: 'deny',
  defaultOutbound: 'allow'
};

// src/homelab/security/ssh-hardening.js

const SSH_HARDENING = {
  config: {
    PermitRootLogin: 'no',
    PasswordAuthentication: 'no',    // Key-only
    PubkeyAuthentication: 'yes',
    MaxAuthTries: 3,
    ClientAliveInterval: 300,
    ClientAliveCountMax: 2,
    X11Forwarding: 'no',
    AllowUsers: 'jeeves',            // Only jeeves user
    Port: 22                         // Change if desired
  },
  fail2ban: {
    maxRetry: 5,
    banTime: '1h',
    findTime: '10m'
  }
};
```

---

## Backup Strategy

```javascript
// src/homelab/backup/restic-manager.js

class BackupManager {
  schedule = {
    // What to back up and when
    critical: {
      paths: [
        '/opt/stacks/',              // All docker compose files
        '/opt/jeeves/',              // Jeeves himself
        '/var/lib/docker/volumes/',  // Container data
      ],
      frequency: 'daily',
      retention: { daily: 7, weekly: 4, monthly: 6 },
      priority: 'critical'
    },
    databases: {
      // pg_dump before backup
      preHook: 'docker exec postgres pg_dumpall > /opt/backups/pg_dump.sql',
      paths: ['/opt/backups/pg_dump.sql'],
      frequency: 'daily',
      retention: { daily: 7, weekly: 4 },
      priority: 'critical'
    },
    media_configs: {
      // Sonarr/Radarr/etc configs (not media files - too large)
      paths: [
        '/opt/stacks/media/config/'
      ],
      frequency: 'weekly',
      retention: { weekly: 4 },
      priority: 'medium'
    }
  };

  async runBackup(tier) {
    const config = this.schedule[tier];
    if (config.preHook) await exec(config.preHook);
    
    for (const path of config.paths) {
      await exec(`restic backup ${path} --tag ${tier}`);
    }
    
    await exec(`restic forget --prune \
      --keep-daily ${config.retention.daily || 0} \
      --keep-weekly ${config.retention.weekly || 0} \
      --keep-monthly ${config.retention.monthly || 0}`);
  }
}
```

---

## Reverse Proxy (Traefik)

Every service gets a clean local domain via Traefik + Pi-hole:

```yaml
# /opt/stacks/core/docker-compose.yml (traefik section)
traefik:
  image: traefik:v3.0
  command:
    - --api.dashboard=true
    - --providers.docker=true
    - --providers.docker.exposedbydefault=false
    - --entrypoints.web.address=:80
    - --entrypoints.websecure.address=:443
    - --certificatesresolvers.letsencrypt.acme.tlschallenge=true
    - --certificatesresolvers.letsencrypt.acme.email=${EMAIL}
    - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - traefik-certs:/letsencrypt
```

Pi-hole provides local DNS:
```
jellyfin.home.local  → 192.168.1.X (Beelink)
nextcloud.home.local → 192.168.1.X
grafana.home.local   → 192.168.1.X
```

---

## Jeeves Homelab Commands

Build these command handlers into Jeeves' intent parser:

```javascript
const HOMELAB_INTENTS = {
  // Status
  'status':           () => getFullSystemStatus(),
  'containers':       () => getContainerList(),
  'resources':        () => getResourceUsage(),
  'temps':            () => getCPUTemperature(),
  
  // Service management
  'start [service]':  (svc) => startService(svc),
  'stop [service]':   (svc) => stopService(svc),
  'restart [service]':(svc) => restartService(svc),
  'logs [service]':   (svc) => getServiceLogs(svc, 50),
  'update [service]': (svc) => updateService(svc),
  'update all':       () => updateAllServices(),
  
  // Install new services
  'install [service]':  (svc) => installService(svc),
  'uninstall [service]':(svc) => uninstallService(svc),
  
  // Network
  'open port [port]':   (port) => addFirewallRule(port),
  'close port [port]':  (port) => removeFirewallRule(port),
  'firewall status':    () => getFirewallRules(),
  'who is connected':   () => getActiveConnections(),
  
  // Backup
  'backup now':         () => runAllBackups(),
  'backup status':      () => getBackupStatus(),
  'restore [service]':  (svc) => restoreService(svc),
  
  // Monitoring
  'alerts':             () => getActiveAlerts(),
  'uptime':             () => getUptimeReport(),
  'bandwidth':          () => getBandwidthUsage(),
  
  // Troubleshooting
  'diagnose [service]': (svc) => runDiagnostics(svc),
  'why is [service] down': (svc) => investigateDowntime(svc),
  'fix [service]':      (svc) => attemptAutoFix(svc)
};
```

---

## Auto-Fix Capabilities

Jeeves should handle common failures without asking:

```javascript
const AUTO_FIX_RULES = {
  container_crashed: {
    action: 'restart',
    maxRetries: 3,
    backoff: [30, 120, 300],  // seconds between retries
    escalate: 'notify owner after 3 failures'
  },
  disk_full: {
    action: 'docker system prune --volumes -f && apt autoremove -y',
    threshold: '90%',
    escalate: 'notify if still above 85% after prune'
  },
  high_memory: {
    action: 'restart highest-memory non-critical container',
    threshold: '95%',
    escalate: 'notify if persists after restart'
  },
  ssl_expiring: {
    action: 'certbot renew',
    threshold: '7 days before expiry',
    escalate: 'notify if renewal fails'
  },
  failed_backup: {
    action: 'retry once',
    escalate: 'notify immediately on second failure'
  },
  ssh_brute_force: {
    action: 'fail2ban handles automatically',
    escalate: 'notify if >100 attempts in 1 hour'
  },
  service_unhealthy: {
    action: 'restart service',
    maxRetries: 2,
    escalate: 'diagnose and notify with findings'
  }
};
```

---

## Directory Structure on Beelink

```
/opt/
├── jeeves/                    # Jeeves application
│   ├── src/
│   ├── config/
│   └── logs/
├── stacks/                    # Docker compose stacks
│   ├── core/                  # Traefik, Pi-hole, Portainer
│   │   └── docker-compose.yml
│   ├── media/                 # Jellyfin, *arr stack
│   │   └── docker-compose.yml
│   ├── services/              # Nextcloud, Vaultwarden, etc
│   │   └── docker-compose.yml
│   ├── databases/             # Postgres, Redis
│   │   └── docker-compose.yml
│   └── monitoring/            # Uptime Kuma, Grafana, Prometheus
│       └── docker-compose.yml
├── backups/                   # Local backup staging
│   └── db-dumps/
└── configs/                   # Service configs (mounted into containers)
    ├── traefik/
    ├── pihole/
    ├── nextcloud/
    └── ...

/data/
├── media/                     # Media files (external drive recommended)
│   ├── movies/
│   ├── tv/
│   └── music/
├── documents/                 # Paperless documents
├── nextcloud/                 # Nextcloud user data
└── vaultwarden/               # Vault data
```

---

## Implementation Priority for Cursor

Build in this order:

```
PHASE 1: Foundation (do first)
├── resource-monitor.js        # Must know system state
├── compose-manager.js         # Must manage Docker
├── container-monitor.js       # Must track container health
├── registry.js                # Must know all services
└── health-checker.js          # Must verify services work

PHASE 2: Security (do second)
├── firewall.js                # Lock down the box
├── ssh-hardening.js           # Secure access
├── audit.js                   # Know what's happening
└── ssl.js                     # Encrypt everything

PHASE 3: Services (do third)
├── Docker compose templates for each service
├── reverse-proxy.js           # Traefik config generation
├── dns.js                     # Pi-hole + local DNS
└── Service-specific configs

PHASE 4: Resilience (do fourth)
├── restic-manager.js          # Backups
├── snapshot-manager.js        # LVM snapshots
├── restore-manager.js         # Disaster recovery
├── updater.js                 # Auto-updates
└── Auto-fix rules

PHASE 5: Monitoring (do fifth)
├── Prometheus + Grafana stack
├── Uptime Kuma
├── Alert rules
└── Dashboard integration
```

---

## Testing

Each capability needs a test command Jeeves can run:

```javascript
const SELF_TESTS = {
  docker: 'docker run --rm hello-world',
  network: 'curl -s https://1.1.1.1/cdn-cgi/trace',
  dns: 'dig +short google.com @127.0.0.1',
  firewall: 'ufw status verbose',
  backup: 'restic snapshots --latest 1',
  ssl: 'openssl s_client -connect localhost:443 -servername home.local',
  postgres: 'docker exec postgres pg_isready',
  redis: 'docker exec redis redis-cli ping',
  disk: 'df -h / | tail -1',
  memory: 'free -m | head -2'
};
```

---

## Network Architecture

Two machines. LAN only. No public exposure.

```
┌──────────────────┐         ┌──────────────────────┐
│  Windows Machine │         │  Daemon (Beelink)    │
│                  │         │  Ubuntu 24.04        │
│  Web Dashboard   │◄──LAN──►│  Jeeves (Node.js)    │
│  (browser)       │  :3847  │  signal-cli          │
│  Cursor (dev)    │◄──SSH───►│  Docker services     │
│                  │  :22    │                      │
└──────────────────┘         └──────────────────────┘
                                      ▲
                                      │ Signal Protocol
                                      ▼
                              ┌──────────────┐
                              │  Your Phone  │
                              │  Signal App  │
                              └──────────────┘
```

### Static IP for Daemon

```yaml
# /etc/netplan/01-netcfg.yaml
network:
  version: 2
  ethernets:
    enp1s0:  # verify with 'ip link'
      dhcp4: no
      addresses:
        - 192.168.1.50/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
```
```bash
sudo netplan apply
```

### Jeeves API Binding

```javascript
// config.json
{
  "api": {
    "host": "0.0.0.0",
    "port": 3847,
    "allowedIPs": ["127.0.0.1", "192.168.1.XX"]  // Windows machine IP
  }
}
```

### Firewall Rules

```bash
# Allow dashboard from LAN only
sudo ufw allow from 192.168.1.0/24 to any port 3847

# Allow SSH from LAN only
sudo ufw allow from 192.168.1.0/24 to any port 22

# Deny everything else inbound
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

### SSH Hardening

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no  # key-based only
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers jeeves

# After editing:
sudo systemctl restart sshd
```

Generate SSH key on Windows:
```powershell
ssh-keygen -t ed25519 -C "cursor@windows"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh jeeves@192.168.1.50 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### Dashboard Access from Windows

Browser: `http://192.168.1.50:3847`

### Cursor Development Access

```powershell
# Direct SSH
ssh jeeves@192.168.1.50

# Or use Cursor Remote SSH to edit Jeeves codebase directly on Daemon
```

### Security Notes

| Concern | Mitigation |
|---------|------------|
| Dashboard on LAN | IP allowlist, LAN subnet only |
| No HTTPS on LAN | Acceptable for local, self-signed cert optional |
| SSH | Key-based only, no passwords, no root |
| External access | Zero ports forwarded to internet |

# Jeeves Linux Setup Guide

Step-by-step: from unboxing the Beelink to Jeeves running and responding on Signal.

---

## Fill These In First

Fill these in as you go. They're referenced throughout the guide as `<PLACEHOLDERS>`.

| Variable | Your Value | Notes |
|----------|-----------|-------|
| `<BEELINK_IP>` | __________ | Static IP you pick for the Beelink (must be outside your router's DHCP range) |
| `<GATEWAY_IP>` | __________ | Your router's IP (check router admin page) |
| `<SUBNET>` | `192.168.4.0/22` | Your LAN subnet |
| `<WIFI_SSID>` | __________ | Your WiFi network name |
| `<WIFI_PASSWORD>` | __________ | Your WiFi password |
| `<INTERFACE>` | `wlo1` | WiFi interface |
| `<SIGNAL_NUMBER>` | __________ | Jeeves' Signal phone number |
| `<YOUR_NUMBER>` | __________ | Your personal Signal number |
| `<ANTHROPIC_KEY>` | __________ | Your Anthropic API key |

---

## Phase 0: What You Need Before Starting

| Item | Details |
|------|---------|
| Beelink Mini S13 | Intel N150, 16GB RAM, 512GB SSD |
| USB stick (8GB+) | For Ubuntu installer |
| Monitor + keyboard | Temporary — only needed for OS install |
| Ethernet cable | Recommended for initial setup (WiFi can be configured after) |
| Your WiFi SSID + password | If going wireless |
| Your phone with Signal | Already registered to your number |
| Anthropic API key | Same one Jeeves uses on Windows |
| Your Signal phone number | The one Jeeves messages you from |

---

## Phase 1: Install Ubuntu Server

### 1.1 Create bootable USB

On your Windows machine:

1. Download Ubuntu Server 24.04 LTS: https://ubuntu.com/download/server
2. Download Rufus: https://rufus.ie
3. Flash the ISO to USB with Rufus (default settings are fine)

### 1.2 Install Ubuntu

1. Plug USB + monitor + keyboard + ethernet into Beelink
2. Power on, mash `F7` or `Del` to enter BIOS boot menu
3. Boot from USB
4. Follow installer:
   - Language: English
   - Install type: **Minimized** (no snap, no extras)
   - Disk: Use entire disk (512GB SSD)
   - Username: `jeeves`
   - Password: pick something strong, you'll disable password SSH later
   - Hostname: `daemon`
   - **Enable OpenSSH server** (check the box!)
   - Don't install any snaps
5. Reboot, remove USB

### 1.3 Enable networking

After reboot, log in on the console. Network interfaces are off by default on Ubuntu Server.

```bash
# See your interfaces (they'll show as DOWN)
ip link

# Find your interface name — ethernet is usually enp1s0 or eth0, WiFi is wlan0
# Write it down, that's your <INTERFACE>
```

**For ethernet:**

```bash
# Enable the interface and get DHCP via networkctl
sudo networkctl up <INTERFACE>

# If that doesn't assign an IP, create a quick netplan:
sudo nano /etc/netplan/01-dhcp.yaml
```

```yaml
network:
  version: 2
  ethernets:
    <INTERFACE>:
      dhcp4: yes
```

```bash
sudo netplan apply
```

**For WiFi:**

```bash
# NetworkManager method (if installed)
sudo nmcli device wifi connect "<WIFI_SSID>" password "<WIFI_PASSWORD>"

# If nmcli isn't available, use netplan:
sudo nano /etc/netplan/01-wifi.yaml
```

```yaml
network:
  version: 2
  wifis:
    wlan0:
      dhcp4: yes
      access-points:
        "<WIFI_SSID>":
          password: "<WIFI_PASSWORD>"
```

```bash
sudo netplan apply
```

**Verify you got an IP:**

```bash
ip addr show <INTERFACE>
```

Once you have an IP (even a temporary DHCP one), you can SSH in from Windows and do the rest remotely.

---

## Phase 2: First SSH Connection (from Windows)

From here on, you can unplug the monitor/keyboard from the Beelink. Everything is via SSH.

```powershell
ssh jeeves@192.168.7.50
```

If you don't have a static IP yet, use the temporary DHCP IP (run `ip addr show` on the console to find it). Accept the fingerprint, enter the password.

---

## Phase 3: WiFi Setup (if going wireless)

Skip this if you're staying on ethernet.

```bash
# List available networks
sudo nmcli device wifi list

# Connect to your network
sudo nmcli device wifi connect "<WIFI_SSID>" password "<WIFI_PASSWORD>"

# Verify
ip addr show wlan0
```

Note the new wireless IP if it's different from ethernet.

---

## Phase 4: Static IP + System Basics

### 4.1 Set a static IP

You need to pick a static IP outside your router's DHCP range so it doesn't change on you.

First, find your gateway IP:

```bash
ip route | grep default
```

The `via` address is your `<GATEWAY_IP>`. Write it down.

Now check what DHCP range your router uses (log into your router's admin page). Pick an IP outside that range but on the same subnet. For a `/22` network like yours (192.168.4.0 - 192.168.7.254), something like `192.168.7.50` is a safe bet.

Delete any existing netplan configs and create a new one:

```bash
sudo rm /etc/netplan/*.yaml
sudo nano /etc/netplan/01-static.yaml
```

Paste this (replace the three placeholders):

```yaml
network:
  version: 2
  wifis:
    wlo1:
      dhcp4: no
      addresses:
        - <BEELINK_IP>/22
      routes:
        - to: default
          via: <GATEWAY_IP>
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
      access-points:
        "<WIFI_SSID>":
          password: "<WIFI_PASSWORD>"
```

```bash
sudo netplan apply
```

**Your SSH session will drop.** Reconnect with the new static IP:

```powershell
ssh jeeves@<BEELINK_IP>
```

### 4.2 Update everything

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

Reconnect after reboot.

### 4.3 Set timezone

```bash
sudo timedatectl set-timezone Africa/Nairobi  # or your timezone
```

---

## Phase 5: SSH Hardening

### 5.1 Generate SSH key on Windows (if you haven't already)

```powershell
ssh-keygen -t ed25519 -C "matth@windows"
```

### 5.2 Copy key to Beelink

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh jeeves@<BEELINK_IP> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### 5.3 Test key-based login

```powershell
ssh jeeves@<BEELINK_IP>
```

It should log in without asking for a password. **Do not close this session yet.**

### 5.4 Disable password login

Open a **second** SSH session (safety net), then in the first:

```bash
sudo nano /etc/ssh/sshd_config
```

Change/add these lines:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers jeeves
```

```bash
sudo systemctl restart ssh
```

Test by opening a **third** SSH session. If it connects, you're good. Close the extras.

---

## Phase 6: Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh

# Add yourself to docker group (no sudo needed for docker commands)
sudo usermod -aG docker jeeves

# Log out and back in for group change to take effect
exit
```

Reconnect and verify:

```bash
docker run --rm hello-world
docker compose version
```

Both should work without `sudo`.

---

## Phase 7: Firewall

```bash
# Allow SSH from LAN only
sudo ufw allow from <SUBNET> to any port 22

# Allow Jeeves dashboard from LAN only
sudo ufw allow from <SUBNET> to any port 3847

# Default deny inbound, allow outbound
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Enable
sudo ufw enable

# Verify
sudo ufw status verbose
```

---

## Phase 8: Install Node.js

```bash
# Install Node.js 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should be v22.x
npm -v
```

Also install build tools (needed for native modules like `better-sqlite3` and `node-pty`):

```bash
sudo apt install -y build-essential python3
```

---

## Phase 9: Install signal-cli

Jeeves talks to Signal via `signal-cli`. This is the most fiddly part.

```bash
# Install Java (signal-cli dependency)
sudo apt install -y openjdk-21-jre-headless

# Download signal-cli (check https://github.com/AsamK/signal-cli/releases for latest)
SIGNAL_CLI_VERSION="0.13.12"
wget "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz"
sudo tar xf "signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz" -C /opt
sudo ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli

# Verify
signal-cli --version
```

### 9.1 Register or link Signal

**Option A: Link to existing Signal account (recommended)**

On the Beelink:

```bash
signal-cli link -n "Jeeves Daemon"
```

This prints a `tsdevice:` URI. You need to turn it into a QR code:

```bash
# Install qrencode
sudo apt install -y qrencode

# Generate QR
signal-cli link -n "Jeeves Daemon" | head -1 | qrencode -t ANSI
```

On your phone: Signal > Settings > Linked Devices > Link New Device > scan the QR.

**Option B: Dedicated number (if you have a spare SIM)**

```bash
signal-cli -u <SIGNAL_NUMBER> register
signal-cli -u <SIGNAL_NUMBER> verify CODE_FROM_SMS
```

### 9.2 Start signal-cli in daemon mode

```bash
# Start the daemon (uses Unix socket)
signal-cli -u <SIGNAL_NUMBER> daemon --socket /tmp/signal-cli.sock &

# Test it works
signal-cli -u <SIGNAL_NUMBER> send -m "Jeeves is alive" <YOUR_NUMBER>
```

### 9.3 Make signal-cli start on boot

```bash
sudo nano /etc/systemd/system/signal-cli.service
```

```ini
[Unit]
Description=signal-cli daemon
After=network.target

[Service]
Type=simple
User=jeeves
ExecStart=/usr/local/bin/signal-cli -u <SIGNAL_NUMBER> daemon --socket /tmp/signal-cli.sock
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable signal-cli
sudo systemctl start signal-cli
```

---

## Phase 10: Clone and Configure Jeeves

### 10.1 Clone the repo

```bash
cd ~
git clone https://github.com/hollidaymat/Jeeves.git signal-cursor-controller
cd signal-cursor-controller
```

### 10.2 Install dependencies

```bash
npm install
```

### 10.3 Create environment file

```bash
nano .env
```

```env
ANTHROPIC_API_KEY=<ANTHROPIC_KEY>
SIGNAL_PHONE_NUMBER=<SIGNAL_NUMBER>
```

### 10.4 Create config.json

```bash
nano config.json
```

```json
{
  "signal": {
    "number": "<SIGNAL_NUMBER>",
    "socket": "/tmp/signal-cli.sock"
  },
  "security": {
    "allowed_numbers": ["<YOUR_NUMBER>"],
    "log_unauthorized": true,
    "silent_deny": true
  },
  "claude": {
    "model": "anthropic/claude-sonnet-4.5",
    "haiku_model": "anthropic/claude-haiku-4",
    "max_tokens": 500
  },
  "projects": {
    "directories": ["/home/jeeves"],
    "scan_depth": 2,
    "markers": [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"],
    "exclude": ["node_modules", ".git", "dist", "build", ".next"]
  },
  "commands": {
    "cursor": "/usr/bin/cursor"
  },
  "server": {
    "host": "0.0.0.0",
    "port": 3847
  },
  "rate_limits": {
    "messages_per_minute": 10,
    "messages_per_hour": 100,
    "messages_per_day": 500
  },
  "homelab": {
    "enabled": true,
    "stacksDir": "/opt/stacks",
    "configsDir": "/opt/configs",
    "backupsDir": "/opt/backups",
    "dataDir": "/data",
    "maxRamMB": 14336,
    "monitorInterval": 60000,
    "thresholds": {
      "cpu": { "warning": 80, "critical": 95 },
      "ram": { "warning": 85, "critical": 95 },
      "disk": { "warning": 80, "critical": 90 },
      "temp": { "warning": 75, "critical": 85 }
    }
  }
}
```

### 10.5 Create homelab directories

```bash
sudo mkdir -p /opt/stacks /opt/configs /opt/backups /data
sudo chown jeeves:jeeves /opt/stacks /opt/configs /opt/backups /data
```

### 10.6 Build and test

```bash
npm run build
npm start
```

You should see Jeeves start up. Send "help" from Signal — if it replies, you're golden.

---

## Phase 11: Run Jeeves as a Service

```bash
sudo nano /etc/systemd/system/jeeves.service
```

```ini
[Unit]
Description=Jeeves AI Assistant
After=network.target signal-cli.service docker.service
Wants=signal-cli.service

[Service]
Type=simple
User=jeeves
WorkingDirectory=/home/jeeves/signal-cursor-controller
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable jeeves
sudo systemctl start jeeves

# Check it's running
sudo systemctl status jeeves

# View logs
journalctl -u jeeves -f
```

---

## Phase 12: Access Dashboard from Windows

Open a browser on your Windows machine:

```
http://192.168.1.50:3847
```

You should see the Jeeves command center UI.

---

## Quick Reference Card

| What | Command / Location |
|------|--------------------|
| SSH to Beelink | `ssh jeeves@192.168.1.50` |
| Dashboard | `http://192.168.1.50:3847` |
| Jeeves logs | `journalctl -u jeeves -f` |
| Signal daemon logs | `journalctl -u signal-cli -f` |
| Restart Jeeves | `sudo systemctl restart jeeves` |
| Restart signal-cli | `sudo systemctl restart signal-cli` |
| Docker status | `docker ps` |
| Update Jeeves code | `cd ~/signal-cursor-controller && git pull && npm run build && sudo systemctl restart jeeves` |

---

## Things to Decide Before You Start

1. **Static IP**: What IP do you want for the Beelink? (suggestion: `192.168.1.50`)
2. **WiFi or Ethernet**: Ethernet is more reliable for a server. WiFi works if cable isn't practical.
3. **Signal setup**: Link to your existing account or use a dedicated number?
4. **Your router's gateway IP**: Usually `192.168.1.1` but check your router.
5. **Your Windows machine's IP**: Needed for firewall allowlisting (or just allow whole `192.168.1.0/24` subnet).

# Gluetun + qBittorrent stack

All qBittorrent traffic goes through the VPN. qBittorrent shares Gluetun’s network (`network_mode: service:gluetun`).

## Deploy (matches Jeeves Docker setup)

1. **Copy stack to `/opt/stacks`** (from repo root, or use “deploy gluetun” from the controller)
   ```bash
   sudo mkdir -p /opt/stacks/gluetun-qbittorrent
   sudo cp docker-compose.yml README.md Dockerfile.qbittorrent /opt/stacks/gluetun-qbittorrent/
   ```
   This stack uses the **main env file** at `/opt/stacks/.env` — no stack-specific `.env`.

2. **Configure VPN**  
   Add your provider’s variables to **`/opt/stacks/.env`** (create the file if it doesn’t exist). Examples:
   - **Mullvad:** `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, optional `SERVER_CITIES`
   - **NordVPN:** `VPN_SERVICE_PROVIDER=nordvpn`, `VPN_TYPE=openvpn`, `OPENVPN_USER`, `OPENVPN_PASSWORD`, `SERVER_COUNTRIES`  
   See [Gluetun wiki](https://github.com/qdm12/gluetun/wiki) for your provider. Reference: `templates/stacks/gluetun-qbittorrent/.env.example` in the repo lists all supported vars.

3. **If you already run qBittorrent alone**  
   Stop the existing qBittorrent stack so ports 8085 and 6881 are free. Copy or reuse the same `qbittorrent_config` volume if you want to keep settings; otherwise this stack creates a new one.

4. **Build and start the stack** (the custom image bakes the WebUI 401 fix into the default config)
   ```bash
   cd /opt/stacks/gluetun-qbittorrent
   docker compose build
   docker compose up -d
   ```

5. **Lidarr / Sonarr / Radarr**  
   They run in a different stack, so they cannot resolve the hostname `gluetun`. Use the **host** and published port instead: `http://daemon:8085` or `http://<host-ip>:8085`. Set the download client URL to that and use the Web UI username/password (e.g. admin; set a permanent password in qBittorrent Web UI after first login). If you later attach this stack to a shared external network, you could use `http://gluetun:8080` (internal) or keep using host:8085.

## Reconfigure Radarr / Sonarr (download client)

After moving qBittorrent to this stack, point Radarr and Sonarr at the host and port:

- In **Radarr**: Settings → Download Clients → qBittorrent → **Host** = `192.168.7.50` (or your daemon hostname), **Port** = `8085`, username/password = your qBittorrent Web UI credentials.
- In **Sonarr**: same (Settings → Download Clients → qBittorrent).

Or via API (from the host that can reach the *arr instances and has `jq`):

```bash
# Radarr (id 1 = qBittorrent)
curl -s -H "X-Api-Key: $RADARR_API_KEY" "http://192.168.7.50:7878/api/v3/downloadclient/1" \
  | jq '.fields |= map(if .name == "host" then .value = "192.168.7.50" else . end)' \
  | curl -s -X PUT -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" -d @- "http://192.168.7.50:7878/api/v3/downloadclient/1"

# Sonarr (id 1 = qBittorrent)
curl -s -H "X-Api-Key: $SONARR_API_KEY" "http://192.168.7.50:8989/api/v3/downloadclient/1" \
  | jq '.fields |= map(if .name == "host" then .value = "192.168.7.50" else . end)' \
  | curl -s -X PUT -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" -d @- "http://192.168.7.50:8989/api/v3/downloadclient/1"
```

## Test with qBittorrent failing

To confirm Radarr and Sonarr report qBittorrent as unreachable when it’s down, run (from repo root or this directory; loads `RADARR_API_KEY` and `SONARR_API_KEY` from `.env`):

```bash
./templates/stacks/gluetun-qbittorrent/test-qbit-failing.sh
```

The script stops qbittorrent, triggers the *arr download-client test for the qBittorrent client, asserts both return “Unable to connect”, then starts qbittorrent again.

## Ports

- **8085** — qBittorrent Web UI on the host (avoids Traefik on 8080). Access at `http://<host>:8085`.
- **6881** — BitTorrent (TCP + UDP)

For the Jeeves controller (qbit status, add torrent): set `QBITTORRENT_URL=http://daemon:8085` (or your host) in the main `.env` so it uses port 8085.

## Fix 401 "Unauthorized" with no login page

If you see only the word "Unauthorized" and no login form when opening `http://<host>:8085`, qBittorrent is rejecting the request (CSRF/Host header checks) before serving the page. This often happens when you open the UI from another machine (e.g. your PC at 192.168.4.x) or a different host than the container expects.

**One-time fix:** disable those checks so the login page is served. On the host that runs Docker, run:

```bash
# 1) Find the config file (path can vary by image version)
docker exec qbittorrent find /config -name 'qBittorrent.conf' 2>/dev/null

# 2) Patch it (use the path from step 1 if different; common is /config/qBittorrent/qBittorrent.conf)
docker exec qbittorrent sh -c '
  CONF=/config/qBittorrent/qBittorrent.conf
  [ -f "$CONF" ] || CONF=/config/qBittorrent.conf
  grep -q "CSRFProtection=false" "$CONF" 2>/dev/null || {
    echo "WebUI\\CSRFProtection=false" >> "$CONF"
    echo "WebUI\\ClickjackingProtection=false" >> "$CONF"
    echo "WebUI\\HostHeaderValidation=false" >> "$CONF"
  }
  cat "$CONF" | tail -5
'
docker restart qbittorrent
```

Step 2 prints the last 5 lines of the config so you can confirm the three `WebUI\...=false` lines were added (each with a single backslash). Then reload `http://<host>:8085` in your browser; you should get the login form.

**Why does grep show nothing after restart?** The app or image can reset/overwrite `qBittorrent.conf` on start, so the three lines disappear after `docker restart`. This stack uses a **custom image** (Dockerfile.qbittorrent) that bakes those lines into the default config so new/fresh configs get the fix. If you already had the stack running with the stock image and the patch keeps disappearing, switch to the custom image (see deploy step 4: copy Dockerfile.qbittorrent, run `docker compose build`, then `up -d`). To force the patched default to be copied again, remove the existing config file (back it up first), then start the container so it copies from `/defaults` (e.g. `docker compose stop qbittorrent`, then `docker run --rm -v gluetun-qbittorrent_qbittorrent_config:/config alpine rm -f /config/qBittorrent/qBittorrent.conf`, then `docker compose start qbittorrent`).

**Still Unauthorized after patching?** Run these on the **daemon host** (192.168.7.50) to see what’s actually answering:

```bash
ss -tlnp | grep 8085
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8085/
curl -v http://127.0.0.1:8085/ 2>&1 | head -30
```

**Interpretation (from daemon run):** Port 8085 is Docker forwarding to qBittorrent; the 401 response (with headers like `content-security-policy`, `x-frame-options`) is from qBittorrent. **401 from 127.0.0.1** means the config patch did not take effect—qBittorrent is rejecting even localhost.

**If you get 401 from localhost:**

1. Confirm the three lines are in the config (run grep **inside** the container):  
   `docker exec qbittorrent grep -E "CSRFProtection|ClickjackingProtection|HostHeaderValidation" /config/qBittorrent/qBittorrent.conf`  
   You should see three lines. **If you see no output:** the image overwrote the config on start (see above). Re-run the patch script, then **do not restart**—open `http://<host>:8085` and log in with the temp password (next section). For a fix that survives restarts, use the **Persistent fix** below.
2. Full stop/start so the app re-reads config:  
   `docker compose stop qbittorrent && docker compose start qbittorrent` (in the stack dir), then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8085/` again.
3. **If the three lines are present and you still get 401:** the Web UI is requiring **login**. Those options don’t disable auth—they only relax checks so the login form can load. Get the **temp password** from `docker logs qbittorrent 2>&1 | grep -i password | tail -3`, open `http://<host>:8085` in a browser, log in as **admin** with that password, then set a permanent password (see “Fix Unauthorized / first-time login” below).
4. If still no login form and no 200, your build may use different option names; see [qBittorrent wiki](https://github.com/qbittorrent/qBittorrent/wiki) for your version.

If **127.0.0.1 returns 200**, use an **SSH tunnel** from your PC: `ssh -L 8085:127.0.0.1:8085 jeeves@192.168.7.50`, then open `http://127.0.0.1:8085` in your browser.

## Fix "Unauthorized" / first-time login

The linuxserver qBittorrent image does not support setting the Web UI password via env; it prints a **temporary password** on each start until you set a permanent one.

1. **Get the temp password** (on the host that runs the stack):
   ```bash
   docker logs qbittorrent 2>&1 | grep -i "password\|administrator" | tail -5
   ```
   You’ll see a line like: `The WebUI administrator password was not set. A temporary password is provided for this session: XXXXXXXX`

2. **Log in in the browser:** open `http://<host>:8085`, username **admin**, password = the temp value from the logs.

3. **Set a permanent password:** in qBittorrent go to **Tools → Options → Web UI**, set a new password and save. If you don’t, a new temp password is generated on every container restart.

4. **Tell Jeeves and *arr:** in your main `.env` set:
   - `QBITTORRENT_URL=http://daemon:8085` (or your host)
   - `QBITTORRENT_USER=admin`
   - `QBITTORRENT_PASS=<the permanent password you set>`

After that, the browser and Jeeves will use the same credentials and "Unauthorized" goes away.

## Download folder and quarantine

The stack mounts **host** `/data/downloads` into the container as **`/downloads`** (qbittorrent) and `/data/downloads` (gluetun). After a fresh qBittorrent install (or config reset), the default save path is `/downloads/`, so completed torrents land in **`/data/downloads`** (and category subfolders like `Movies`, `tv-sonarr`).

If you use a **quarantine** so completed downloads sit in `/data/downloads/quarantine` before *arr import:

1. **Ensure the directory exists on the host:**  
   `mkdir -p /data/downloads/quarantine`  
   (You already have `/data/downloads/quarantine` if you used quarantine before.)

2. **Set qBittorrent’s default save path to the quarantine folder:**  
   In qBittorrent Web UI: **Tools → Options → Downloads** → set **Default Save Path** to **`/downloads/quarantine`** (path inside the container; it maps to host `/data/downloads/quarantine`).  
   Optionally set **Keep incomplete torrents in** to **`/downloads/incomplete`** if you want incomplete files separate. Save.

3. **Radarr/Sonarr/Lidarr** use `/data/downloads` in their containers, so they will see `/data/downloads/quarantine` and any category subdirs (e.g. `quarantine/Movies`, `quarantine/tv-sonarr`). The download client reports the path where the torrent completed. **You must add a Remote Path Mapping** so *arr can find those files (see below).

**Remote Path Mapping (required for *arr to see quarantine):** qBittorrent reports paths like `/downloads/quarantine/...` (paths inside its container). Radarr/Sonarr run in other containers and don’t have `/downloads`; they have `/data/downloads`. Add a **Remote Path Mapping** in each app so the reported path is translated:

- **Settings → Download Clients → Remote Path Mappings**
- **Host:** must match the **exact host** you use for the qBittorrent download client (e.g. `192.168.7.50` or `daemon`). If you use `192.168.7.50` in the qBittorrent client, the mapping Host must be `192.168.7.50` — a mapping for `gluetun` will not be used.
- **Remote Path:** `/downloads/`
- **Local Path:** `/data/downloads/`

Then paths like `/downloads/quarantine/MovieName` become `/data/downloads/quarantine/MovieName` inside *arr and the health warning goes away. After that, completed download handling can import from quarantine into the library and Jellyfin will see the media.

**Re-apply via script after reinstall:** From the repo root (with `.env` containing `QBITTORRENT_URL`, `QBITTORRENT_USER`, `QBITTORRENT_PASS`), run:
```bash
./templates/stacks/gluetun-qbittorrent/scripts/set-quarantine-path.sh
```
This sets the default save path to `/downloads/quarantine` via the qBittorrent API.

**Move recent downloads into quarantine:** If completed torrents previously landed in `/data/downloads` (or `/data/downloads/complete`) instead of quarantine, move them in one shot (on the host that has `/data/downloads`):
```bash
./templates/stacks/gluetun-qbittorrent/scripts/move-recent-downloads-to-quarantine.sh [/data/downloads]
```
Default is `/data/downloads`. Skips the subdirs `incomplete`, `quarantine`, `torrents`, `usenet` and moves all other top-level files/folders into `quarantine/`.

**Summary:** After reinstall, run `set-quarantine-path.sh` to restore the save path; use `move-recent-downloads-to-quarantine.sh` once to move any misplaced completions.

### Malware scan before import

To avoid malicious downloads reaching the library, scan quarantine **before** Radarr/Sonarr/Lidarr import. Clean files stay in place; infected items are moved out so *arr never see them.

**Flow:** qBittorrent completes → files land in `/data/downloads/quarantine` → scanner runs → **clean:** leave in place (*arr import as usual) → **infected:** move to `quarantine/infected/` and optionally remove the torrent from qBittorrent so *arr don’t attempt import.

**Run the scanner:** Use the script from the repo (requires ClamAV on the host: `apt install clamav` then `freshclam` to update definitions):

```bash
./templates/stacks/gluetun-qbittorrent/scripts/scan-quarantine.sh
```

- **Scheduling:** Run via cron every 1–2 minutes (e.g. `*/2 * * * * …/scan-quarantine.sh`). The scan interval should be **less** than *arr’s “Completed Download Handling” interval (e.g. 1 min scan, 2 min *arr) so new completions are scanned before *arr pick them up.
- **Optional qBittorrent cleanup:** If `QBITTORRENT_URL`, `QBITTORRENT_USER`, and `QBITTORRENT_PASS` are set (e.g. in `.env`), the script will remove infected torrents from qBittorrent via API so *arr don’t try to import the moved path.
- **`infected/`:** The script skips the `infected/` subdir (no re-scan). *arr only see content under quarantine that wasn’t moved; anything in `quarantine/infected/` is excluded from import.

**Alternative:** Run ClamAV in a Docker container that mounts `/data/downloads` and run this script inside it (or call `clamscan` from the host against the same path). Document the same scheduling and interval requirement.

## Volumes

- `gluetun_config` — Gluetun state
- `qbittorrent_config` — qBittorrent config
- `/data/downloads` — shared download path (Lidarr/Sonarr/Radarr completed handling). Use `/data/downloads/quarantine` as qBittorrent default save path if you use quarantine.

## Verify VPN

- Gluetun health: `curl http://localhost:9999/` (inside container) or check logs: `docker logs gluetun`
- Check exit IP: from host, `docker exec gluetun wget -qO- https://ipinfo.io/ip` (should be VPN IP, not your ISP).

## VPN and download speed optimization

If VPN throughput is low (e.g. single-stream tests ~500–700 KB/s while host is faster), try the following.

**1. Prefer WireGuard over OpenVPN**  
WireGuard typically gives higher throughput and lower overhead. With NordVPN you can use NordLynx (WireGuard): set `VPN_TYPE=wireguard` and supply a WireGuard private key. Get the key from a machine with the official NordVPN app: set technology to Nordlynx, connect, then run `sudo wg show nordlynx private-key`. Add `WIREGUARD_PRIVATE_KEY` and (if needed) `WIREGUARD_ADDRESSES` / `NORDVPN_SERVER` to your env. See [Gluetun NordVPN wiki](https://github.com/qdm12/gluetun-wiki) and `.env.example` for optional vars.

**2. MTU / MSS**  
Fragmentation can cap speed. In your stack env (e.g. `/opt/stacks/.env`), try:
- **OpenVPN:** `OPENVPN_MSSFIX=1400`
- **WireGuard:** `WIREGUARD_MTU=1400`  
Restart Gluetun after changing. If you see DNS or connection timeouts, try 1360 instead.

**3. Server selection**  
Use a closer or less loaded server: set `SERVER_CITIES` (e.g. your city or region) or, for NordVPN, `NORDVPN_SERVER=us1234.nordvpn.com` (pick a specific server from NordVPN’s list). Restart Gluetun to apply.

**4. qBittorrent**  
- **Settings → Speed:** leave “Global rate limit” unchecked (or set high) so the client isn’t capping.
- **Settings → BitTorrent:** raise “Global maximum number of connections” (e.g. 500) and “Maximum number of connections per torrent” (e.g. 100).  
Restart qBittorrent after changes.

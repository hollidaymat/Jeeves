# Gluetun + qBittorrent stack

All qBittorrent traffic goes through the VPN. qBittorrent shares Gluetun’s network (`network_mode: service:gluetun`).

## Deploy (matches Jeeves Docker setup)

1. **Copy stack to `/opt/stacks`** (from repo root, or use “deploy gluetun” from the controller)
   ```bash
   sudo mkdir -p /opt/stacks/gluetun-qbittorrent
   sudo cp docker-compose.yml README.md /opt/stacks/gluetun-qbittorrent/
   ```
   This stack uses the **main env file** at `/opt/stacks/.env` — no stack-specific `.env`.

2. **Configure VPN**  
   Add your provider’s variables to **`/opt/stacks/.env`** (create the file if it doesn’t exist). Examples:
   - **Mullvad:** `VPN_SERVICE_PROVIDER=mullvad`, `VPN_TYPE=wireguard`, `WIREGUARD_PRIVATE_KEY`, `WIREGUARD_ADDRESSES`, optional `SERVER_CITIES`
   - **NordVPN:** `VPN_SERVICE_PROVIDER=nordvpn`, `VPN_TYPE=openvpn`, `OPENVPN_USER`, `OPENVPN_PASSWORD`, `SERVER_COUNTRIES`  
   See [Gluetun wiki](https://github.com/qdm12/gluetun/wiki) for your provider. Reference: `templates/stacks/gluetun-qbittorrent/.env.example` in the repo lists all supported vars.

3. **If you already run qBittorrent alone**  
   Stop the existing qBittorrent stack so ports 8085 and 6881 are free. Copy or reuse the same `qbittorrent_config` volume if you want to keep settings; otherwise this stack creates a new one.

4. **Start the stack**
   ```bash
   cd /opt/stacks/gluetun-qbittorrent
   docker compose up -d
   ```

5. **Lidarr / Sonarr / Radarr**  
   Point them at `qbittorrent:8085` (same as before if they use the container name). If those apps are on the same host/network, no change needed.

## Ports

- **8085** — qBittorrent Web UI (same as your current setup)
- **6881** — BitTorrent (TCP + UDP)

## Volumes

- `gluetun_config` — Gluetun state
- `qbittorrent_config` — qBittorrent config
- `/data/downloads` — shared download path (Lidarr/Sonarr/Radarr completed handling)

## Verify VPN

- Gluetun health: `curl http://localhost:9999/` (inside container) or check logs: `docker logs gluetun`
- Check exit IP: from host, `docker exec gluetun wget -qO- https://ipinfo.io/ip` (should be VPN IP, not your ISP).

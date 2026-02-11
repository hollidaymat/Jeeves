# VPN for media downloads (Gluetun + qBittorrent)

Torrent traffic from qBittorrent can be routed through a VPN so your public IP is not exposed. Jeeves uses the **Gluetun + qBittorrent** stack for this.

## Stack location

- **Template (in repo):** `templates/stacks/gluetun-qbittorrent/`
- **Deployed path:** `/opt/stacks/gluetun-qbittorrent/docker-compose.yml` (same pattern as other stacks)

The stack runs Gluetun (VPN) and qBittorrent with `network_mode: service:gluetun`, so all qBittorrent traffic goes through the VPN.

## Quick deploy

1. Copy the template to `/opt/stacks/gluetun-qbittorrent/` (see `templates/stacks/gluetun-qbittorrent/README.md`).
2. Add your VPN provider variables to the **main env file** at `/opt/stacks/.env` (create it if needed). See [Gluetun wiki](https://github.com/qdm12/gluetun/wiki) and `.env.example` in the stack template for variable names.
3. If qBittorrent is already running as a separate stack, stop it so ports 8085 and 6881 are free.
4. Run: `docker compose -f /opt/stacks/gluetun-qbittorrent/docker-compose.yml up -d`.

Lidarr, Sonarr, and Radarr keep using `qbittorrent:8085`; no change needed if they resolve the container name on the same Docker network.

## Verify

- `docker logs gluetun` — should show VPN connected.
- `docker exec gluetun wget -qO- https://ipinfo.io/ip` — should show the VPN exit IP, not your ISP.

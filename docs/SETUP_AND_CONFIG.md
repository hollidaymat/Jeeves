# Jeeves homelab – setup and configuration

This doc lists what you need to set up or configure so Jeeves can talk to your services. All credentials and URLs live in the project root **`.env`** file.

---

## Already configured (no action)

These are already set in `.env` and work as-is:

| Service        | Auth type   | Notes |
|----------------|------------|--------|
| Jellyfin       | user/pass  | jeeves / whyaskjeeves |
| Prowlarr       | API key    | Set |
| Sonarr         | API key    | Set |
| Radarr         | API key    | Set |
| Lidarr         | API key    | Set |
| Bazarr         | API key    | Set |
| Overseerr      | API key    | Set |
| Nextcloud      | user/pass  | jeeves / whyaskjeeves |
| Pi-hole        | API key    | jeeves2026 |
| Grafana        | user/pass  | admin / whyaskjeeves |
| Uptime Kuma    | URL only   | No API key in .env |
| NZBGet         | user/pass  | nzbget / tegbzn6789 |
| qBittorrent    | user/pass  | jeeves / whyaskjeeves |
| Gluetun/VPN    | NordVPN    | OpenVPN credentials set |

---

## You need to do this

### 1. Portainer – API token

Jeeves uses an API token, not your login password.

1. Open Portainer: `http://192.168.7.50:9000`
2. Log in as **jeeves** / **whyaskjeeves**
3. Go to **Users** (left) → click **jeeves** → **Add access token**
4. Name it (e.g. `jeeves-bot`), create, then **copy the token**
5. In `signal-cursor-controller/.env`, set:
   ```bash
   PORTAINER_API_KEY=<paste token here>
   ```

---

### 2. Paperless-ngx – API token

Paperless uses tokens for API access (not the superuser password).

1. Open Paperless: `http://192.168.7.50:8000`
2. Log in (e.g. user **8000** and your password)
3. Go to **Settings** (gear) → **Security** → **Auth tokens**
4. **Create token** (name e.g. `jeeves`), copy it
5. In `.env`, set:
   ```bash
   PAPERLESS_API_KEY=<paste token here>
   ```

---

### 3. Home Assistant – long-lived token

1. Open Home Assistant: `http://192.168.7.50:8123`
2. Log in as **jeeves** / **whyaskjeeves**
3. Click your **profile** (bottom left) → **Long-lived access tokens**
4. **Create token** (name e.g. `Jeeves`), copy it (shown once)
5. In `.env`, set:
   ```bash
   HA_TOKEN=<paste token here>
   ```

---

## Optional checks

- **Host:** All URLs use `192.168.7.50`. If Jeeves runs on the same machine as Docker, you can use `http://localhost:<port>` instead for any service.
- **Pi-hole:** `.env` uses port **8053**. If your Pi-hole admin is on port 80 (or another port), change:
  ```bash
  PIHOLE_URL=http://192.168.7.50:80
  ```
- **Overseerr / Jellyseerr:** `.env` uses port **5055**. If you use a different port, update:
  ```bash
  OVERSEERR_URL=http://192.168.7.50:<your port>
  ```

---

## After editing `.env`

- Restart the Jeeves process (or redeploy) so it picks up new or changed env vars.
- Run **“Give me a homelab report”** in Signal to confirm which services Jeeves can reach.

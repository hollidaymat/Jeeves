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

### 4. Vaultwarden – HTTPS required (Subtle Crypto API)

Vaultwarden’s web vault uses the Subtle Crypto API, which only works over HTTPS. Use the IP directly so no hosts file is needed:

1. Deploy the Vaultwarden stack: `templates/stacks/vaultwarden/docker-compose.yml`
2. Uses `https://192.168.7.50:8843` and the same cert.pem/key.pem as Jeeves.
3. In `.env`: `VAULTWARDEN_URL=https://192.168.7.50:8843`
4. Open **https://192.168.7.50:8843** and accept the self-signed cert once.

---

### 5. Home Assistant Community Store (HACS)

HACS lets you install community integrations, themes, and frontend plugins. Use this if Home Assistant runs in **Docker**.

**Prerequisites:** Home Assistant 2024.4.1 or newer. Outgoing access to GitHub (and Cloudflare) must not be blocked.

**Install (Container / Docker):**

1. Find the Home Assistant container name:
   ```bash
   docker ps --format '{{.Names}}' | grep -i home
   ```

2. Run the HACS download script inside the container:
   ```bash
   docker exec -it <container_name> bash -c "wget -O - https://get.hacs.xyz | bash -"
   ```
   Replace `<container_name>` with the name from step 1. If the image has no `bash`, use `sh`:
   ```bash
   docker exec -it <container_name> sh -c "wget -O - https://get.hacs.xyz | sh -"
   ```

3. Restart Home Assistant (restart the container or **Settings → System → Restart** in HA).

4. In the browser: **clear cache** or hard refresh (Ctrl+Shift+R). Go to **Settings → Devices & services → Add integration**, search for **HACS**, select it, acknowledge, **Submit**.

5. **GitHub auth:** Copy the device code, open [https://github.com/login/device](https://github.com/login/device), sign in, enter the code, **Authorize HACS**. Back in HA, assign HACS to an area, **Finish**.

Use **HACS** in the sidebar to browse and install integrations, themes, and frontend modules.

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

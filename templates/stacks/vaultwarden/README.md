# Vaultwarden stack (HTTPS via IP)

Vaultwarden requires HTTPS for the Subtle Crypto API. Serves at `https://192.168.7.50:8843`.

## Deploy

1. In `signal-cursor-controller/.env` set:
   ```bash
   ADMIN_TOKEN=your-secure-admin-password
   ```

2. Deploy or redeploy:
   ```bash
   cd /home/jeeves/signal-cursor-controller/templates/stacks/vaultwarden
   docker compose down
   docker compose up -d
   ```

3. In `.env` add (use the same value as `ADMIN_TOKEN`, i.e. the password you use to log in to the admin panel):
   ```bash
   VAULTWARDEN_URL=https://192.168.7.50:8843
   VAULTWARDEN_ADMIN_TOKEN=<your admin password>
   ```
   If `ADMIN_TOKEN` is an Argon2 PHC hash, use the plain password you used to generate it.

4. Restart Jeeves: `sudo systemctl restart jeeves`

# Antigravity + Jeeves: setup (no QA browser)

Get Jeeves orchestrating Antigravity **without** the QA browser (serve-web). Jeeves uses Anthropic for planning; Antigravity uses its own free LLMs for coding once you're logged in.

---

## 1. Install Antigravity

**Ubuntu/Debian (recommended):**

```bash
sudo bash /path/to/signal-cursor-controller/scripts/install-antigravity-apt.sh
```

Or add the repo and install manually: [antigravity.google/download/linux](https://antigravity.google/download/linux).

Verify:

```bash
antigravity --version
# e.g. Antigravity 1.18.3
```

---

## 2. Log in to Antigravity (required, one-time)

Antigravity uses your **Google account** for its free models (e.g. Gemini). The CLI (`antigravity chat`) uses the **same stored session** as the desktop app. If you never log in, `antigravity chat` will have no credentials and will fail or hang.

**Do this once, on the same machine (and ideally the same user) that will run Jeeves:**

1. **Open Antigravity** so you can complete sign-in:
   - **With a display:** run `antigravity` (or open it from the app menu). Sign in with your Google (Gmail) account when prompted. Finish any first-time setup (theme, policies). Then close the app.
   - **Headless/SSH:** If Jeeves runs as a system user (e.g. `jeeves`) with no desktop, that user has no Antigravity session. Either:
     - Run Jeeves as your **normal desktop user** (the one that can run `antigravity` and has logged in), or
     - On the server, log in once as that user with a virtual display, e.g.:
       ```bash
       sudo apt install xvfb
       xvfb-run -a antigravity
       ```
       Then complete Google sign-in in the virtual display (or use a one-time SSH tunnel + browser on your PC to complete auth if the app supports it).

2. **Confirm session is stored** (optional):
   - Config/session is usually under `~/.config/Google/Antigravity` or `~/.antigravity` (or similar). If that directory exists and was updated after you signed in, the CLI can use it.

3. **Same user for Jeeves:** Run the Jeeves process (e.g. systemd service) as the **same OS user** that logged into Antigravity. Otherwise `antigravity chat` won’t see the stored login.

---

## 3. Jeeves env (orchestrator, no QA browser)

In `.env` (or your Jeeves env):

```bash
# Jeeves uses Anthropic for PRD/spec/validation (you need this)
ANTHROPIC_API_KEY=sk-ant-api03-...

# Use Antigravity for the coding step (antigravity chat --mode agent)
ANTIGRAVITY_USE_CHAT=true

# Optional: write spec only, don't run Antigravity (for testing handoff)
# ANTIGRAVITY_HANDOFF_ONLY=true

# Optional: stub the Antigravity run (for testing the rest of the pipeline)
# ANTIGRAVITY_STUB=true
```

**Do not set** `ANTIGRAVITY_SERVE_WEB` if you're skipping the QA browser (and on Linux it won’t work anyway without the tunnel binary).

---

## 4. Run Jeeves

Start Jeeves as usual (e.g. `npm run start` or your systemd service). Ensure it runs as the **same user** that completed Antigravity login (see step 2).

---

## 5. Test the flow (no QA)

1. **Handoff only (no build):**  
   Send: **"send to antigravity: add a hello world endpoint"**  
   Jeeves should write a spec under `TASK_TEMP_DIR` (default `/tmp/antigravity_tasks/`) and reply with the path. No Antigravity run yet.

2. **Full run:**  
   Send: **"build add a hello world endpoint"** (or **"orchestrate add a hello endpoint"**).  
   Jeeves will:
   - Do PRD intake (Anthropic)
   - Generate a spec (Anthropic)
   - Run `antigravity chat --mode agent` with that spec (Antigravity’s LLMs, using your stored login)
   - Validate and iterate or report success/failure

If `antigravity chat` fails with auth errors or hangs, go back to step 2 and ensure that user has logged into Antigravity at least once.

---

## 6. Headless / no DISPLAY

If Jeeves runs on a headless server (no X11/Wayland), `antigravity chat` may try to open a window and fail. Options:

- Run Jeeves on a machine (or user session) that **has** a display (e.g. your desktop), or
- Try running the Antigravity command under **xvfb** so it has a virtual display (we don’t set this by default; you’d need to wrap the `antigravity` call in `xvfb-run` in your environment or a custom script).

---

## Summary

| Step | What |
|------|------|
| 1 | Install Antigravity (APT or tarball). |
| 2 | **Log in once** with a Google account (same user that will run Jeeves). |
| 3 | Set `ANTIGRAVITY_USE_CHAT=true` and `ANTHROPIC_API_KEY` in Jeeves env. |
| 4 | Run Jeeves as that same user. |
| 5 | Use "build …" or "orchestrate …" (and optionally "send to antigravity: …" for handoff-only). |

No QA browser, no serve-web, no tunnel — just Jeeves (Anthropic) + Antigravity (your logged-in session) for the coding step.

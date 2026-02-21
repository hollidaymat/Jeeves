# Aider + Jeeves Orchestrator Setup

Get Jeeves orchestrating Aider for code generation. Jeeves handles PRD intake, spec generation, and validation; Aider runs headless for the coding step. No browser, no login—just `ANTHROPIC_API_KEY`.

---

## 1. Install Aider

On Ubuntu 24.04+ (PEP 668), use **pipx** (recommended) or a venv:

```bash
# Option A: pipx (isolated, adds aider to PATH)
sudo apt install pipx
pipx ensurepath   # add ~/.local/bin to PATH
pipx install aider-chat

# Option B: venv
python3 -m venv ~/.local/share/aider-venv
~/.local/share/aider-venv/bin/pip install aider-chat
export PATH="$HOME/.local/share/aider-venv/bin:$PATH"
```

Verify:

```bash
aider --version
```

Or use the install script:

```bash
bash /path/to/signal-cursor-controller/scripts/install-aider.sh
```

---

## 2. Jeeves Environment

In `.env` (or your Jeeves env):

```bash
# Jeeves and Aider both use this
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional
AIDER_MODEL=claude-sonnet-4-6
TASK_TEMP_DIR=/tmp/jeeves_tasks
# If aider not in PATH (e.g. venv): AIDER_BIN=/path/to/aider
```

**Do not set** `AIDER_STUB` for real runs (only for testing). **Do not set** `AIDER_HANDOFF_ONLY` unless you want spec-only (no build).

---

## 3. Run Jeeves

Start Jeeves as usual. Ensure it runs from (or has `PROJECT_ROOT` / `AIDER_WORK_DIR` set to) the project directory where Aider should edit code.

---

## 4. Test the Flow

1. **Handoff only:**  
   Send: **"send to aider: add a hello world endpoint"**  
   Jeeves writes a spec to `TASK_TEMP_DIR` and returns the path. No Aider run.

2. **Full run:**  
   Send: **"build add a hello world endpoint"** or **"orchestrate add a hello endpoint"**  
   Jeeves will:
   - Do PRD intake
   - Generate a spec
   - Run `aider --message-file <spec> --yes` (Aider’s LLMs)
   - Validate and iterate or report success/failure

---

## 5. Working Directory

Aider runs in `process.cwd()` by default. Override with:

- `PROJECT_ROOT` – project root for Aider
- `AIDER_WORK_DIR` – same effect
- `AIDER_TARGET_DIRS` – space-separated dirs (default `src`)

Example:

```bash
PROJECT_ROOT=/home/jeeves/my-app AIDER_TARGET_DIRS="src tests" npm run start
```

---

## Summary

| Step | What |
|------|------|
| 1 | `pipx install aider-chat` (or venv; see above) |
| 2 | Set `ANTHROPIC_API_KEY` in Jeeves env |
| 3 | Run Jeeves from project root (or set `PROJECT_ROOT`) |
| 4 | Use "build …" or "orchestrate …" (and optionally "send to aider: …" for handoff) |

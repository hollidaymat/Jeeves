# Signal Cursor Controller - Product Requirements Document

**Version:** 1.0  
**Date:** February 3, 2026  
**Status:** Ready to Build

---

## Overview

A lightweight bridge that allows you to control Cursor IDE on your laptop via Signal messages from your phone. Natural language commands are interpreted by Claude and executed locally.

**Problem:** Cursor offers remote control features but requires additional payment on top of the $200/month Max subscription.

**Solution:** Build it ourselves. More flexible, no additional cost, fully controlled.

---

## Goals

1. Control Cursor IDE from phone via Signal
2. Natural language interpretation (not rigid commands)
3. Secure - only your phone number can issue commands
4. Extensible - terminal commands can be added later
5. Zero additional subscription costs

---

## Non-Goals (Phase 1)

- Voice commands
- WhatsApp support
- Terminal command execution
- Multi-user support
- Web interface

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         LAPTOP                                   │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  signal-cli  │    │         Bridge Server (Node.js)      │   │
│  │  (daemon)    │◀──▶│                                      │   │
│  │              │    │  ┌─────────┐  ┌─────────┐  ┌──────┐  │   │
│  └──────────────┘    │  │ Message │  │ Intent  │  │ Exec │  │   │
│         ▲            │  │ Handler │─▶│ Parser  │─▶│ utor │  │   │
│         │            │  └─────────┘  └────┬────┘  └──┬───┘  │   │
│         │            │                    │          │      │   │
│         │            └────────────────────┼──────────┼──────┘   │
│         │                                 │          │          │
│         │                                 ▼          ▼          │
│         │                          ┌──────────┐ ┌────────┐      │
│         │                          │  Claude  │ │ Cursor │      │
│         │                          │  API     │ │ CLI    │      │
│         │                          └──────────┘ └────────┘      │
└─────────┼───────────────────────────────────────────────────────┘
          │
          │ Signal Protocol (encrypted)
          │
    ┌─────▼─────┐
    │   Phone   │
    │  (Signal) │
    └───────────┘
```

---

## Components

### 1. signal-cli Daemon

**Purpose:** Interface with Signal network

**Setup:**
- Install signal-cli (requires Java 17+)
- Link to existing Signal account OR register new number
- Run in daemon mode with JSON-RPC interface

**Commands:**
```bash
# Link to existing Signal (shows QR code)
signal-cli link -n "Cursor Controller"

# Or register new number
signal-cli -u +1YOURPHONE register
signal-cli -u +1YOURPHONE verify CODE

# Run daemon
signal-cli -u +1YOURPHONE daemon --socket /tmp/signal-cli.sock
```

### 2. Message Handler

**Purpose:** Receive messages, filter by allowlist, route to parser

**Responsibilities:**
- Connect to signal-cli via Unix socket or TCP
- Filter messages - only process from allowlisted numbers
- Pass message content to Intent Parser
- Send responses back via signal-cli

**Security:**
```javascript
const ALLOWED_NUMBERS = [
  '+1YOURPHONENUMBER'  // Only your phone
];

function isAuthorized(sender) {
  return ALLOWED_NUMBERS.includes(sender);
}
```

### 3. Intent Parser (Claude)

**Purpose:** Convert natural language to structured commands

**Input:** "open the basecamp project"

**Output:**
```json
{
  "action": "open_project",
  "target": "basecamp",
  "resolved_path": "/Users/you/projects/basecamp",
  "command": "cursor /Users/you/projects/basecamp",
  "confidence": 0.95
}
```

**System Prompt:**
```
You are a command interpreter for Cursor IDE. Convert natural language requests into executable commands.

Available actions:
- open_project: Open a project folder in Cursor
- open_file: Open a specific file
- goto_line: Navigate to a specific line in a file
- resume_chat: Resume the last Cursor agent conversation
- list_chats: List recent Cursor agent conversations

Known projects (update this list):
- basecamp: /Users/you/projects/basecamp
- divemanagement: /Users/you/projects/divemanagement
- signal-controller: /Users/you/projects/signal-controller

Respond ONLY with JSON. If you cannot interpret the request, respond with:
{"action": "unknown", "message": "Could not understand request"}

If the request is potentially dangerous or outside scope, respond with:
{"action": "denied", "message": "Request not allowed"}
```

### 4. Command Executor

**Purpose:** Execute validated commands safely

**Allowed Executables (Whitelist):**
```javascript
const ALLOWED_COMMANDS = {
  'cursor': '/usr/local/bin/cursor',
  'agent': '/usr/local/bin/agent'  // Cursor agent CLI
};
```

**Execution Flow:**
1. Receive parsed intent from Claude
2. Validate action is in whitelist
3. Build command string (no shell interpolation)
4. Execute via spawn (not exec - no shell)
5. Capture stdout/stderr
6. Return result to Message Handler

**Safety:**
```javascript
const { spawn } = require('child_process');

function executeCommand(parsed) {
  // Only allow whitelisted commands
  const executable = ALLOWED_COMMANDS[parsed.command.split(' ')[0]];
  if (!executable) {
    return { success: false, error: 'Command not allowed' };
  }
  
  // Use spawn, not exec - no shell injection
  const args = parsed.command.split(' ').slice(1);
  const child = spawn(executable, args);
  
  // ... handle output
}
```

---

## Data Flow

### Happy Path

```
1. You text Signal: "open basecamp"
           │
           ▼
2. signal-cli daemon receives message
           │
           ▼
3. Message Handler checks sender against allowlist
           │ (authorized)
           ▼
4. Intent Parser sends to Claude:
   "Convert to command: open basecamp"
           │
           ▼
5. Claude responds:
   {"action": "open_project", "command": "cursor /projects/basecamp"}
           │
           ▼
6. Executor validates and runs:
   spawn('/usr/local/bin/cursor', ['/projects/basecamp'])
           │
           ▼
7. Cursor opens on laptop
           │
           ▼
8. Response sent back to Signal:
   "Opened basecamp project"
```

### Unauthorized Attempt

```
1. Unknown number texts: "open basecamp"
           │
           ▼
2. signal-cli daemon receives message
           │
           ▼
3. Message Handler checks sender against allowlist
           │ (NOT authorized)
           ▼
4. Log attempt, do not respond (silent drop)
```

---

## Commands Supported (Phase 1)

| Natural Language | Interpreted Action | Executed Command |
|------------------|-------------------|------------------|
| "open basecamp" | open_project | `cursor /projects/basecamp` |
| "open the PRD" | open_file | `cursor /projects/basecamp/Basecamp_PRD.md` |
| "open page.tsx in basecamp" | open_file | `cursor /projects/basecamp/app/page.tsx` |
| "go to line 50" | goto_line | `cursor --goto /current/file.tsx:50` |
| "resume chat" | resume_chat | `agent resume` |
| "list chats" | list_chats | `agent ls` |
| "status" | status_check | Returns system status |
| "help" | help | Returns available commands |

---

## Configuration

### config.json

```json
{
  "signal": {
    "number": "+1YOURPHONENUMBER",
    "socket": "/tmp/signal-cli.sock"
  },
  "security": {
    "allowed_numbers": ["+1YOURPHONENUMBER"],
    "log_unauthorized": true,
    "silent_deny": true
  },
  "claude": {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 500
  },
  "projects": {
    "basecamp": "/Users/you/projects/basecamp",
    "divemanagement": "/Users/you/projects/divemanagement"
  },
  "commands": {
    "cursor": "/usr/local/bin/cursor",
    "agent": "/usr/local/bin/agent"
  }
}
```

---

## File Structure

```
signal-cursor-controller/
├── package.json
├── config.json
├── src/
│   ├── index.js           # Entry point, starts daemon
│   ├── signal.js          # signal-cli interface
│   ├── handler.js         # Message routing and auth
│   ├── parser.js          # Claude intent parsing
│   ├── executor.js        # Command execution
│   └── logger.js          # Logging utility
├── scripts/
│   ├── setup-signal.sh    # signal-cli setup helper
│   └── start.sh           # Start the bridge
└── README.md
```

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```

**System Requirements:**
- Node.js 18+
- Java 17+ (for signal-cli)
- signal-cli (installed separately)
- macOS or Linux (Windows untested)

---

## Setup Instructions

### 1. Install signal-cli

```bash
# macOS
brew install signal-cli

# Linux (manual)
wget https://github.com/AsamK/signal-cli/releases/download/v0.13.0/signal-cli-0.13.0.tar.gz
tar xf signal-cli-0.13.0.tar.gz
sudo mv signal-cli-0.13.0 /opt/signal-cli
sudo ln -s /opt/signal-cli/bin/signal-cli /usr/local/bin/
```

### 2. Link Signal Account

```bash
# Option A: Link to existing phone (recommended)
signal-cli link -n "Cursor Controller"
# Scan QR code with Signal app: Settings > Linked Devices

# Option B: Register new number
signal-cli -u +1NEWPHONE register
signal-cli -u +1NEWPHONE verify CODE
```

### 3. Install Project

```bash
git clone <repo>
cd signal-cursor-controller
npm install
cp config.example.json config.json
# Edit config.json with your settings
```

### 4. Set API Key

```bash
export ANTHROPIC_API_KEY=your_key_here
# Or add to config.json
```

### 5. Start

```bash
# Terminal 1: signal-cli daemon
signal-cli -u +1YOURPHONE daemon --socket /tmp/signal-cli.sock

# Terminal 2: Bridge server
npm start
```

### 6. Test

Text yourself from your phone:
```
"status"
→ "Signal Cursor Controller is running. Ready for commands."

"open basecamp"
→ "Opened basecamp project"
```

---

## Security Model

### Threat: Unauthorized Access

| Vector | Mitigation |
|--------|------------|
| Unknown number texts commands | Allowlist - only your number accepted |
| Number spoofing | Signal protocol prevents spoofing |
| Stolen phone | Require Signal PIN/biometrics on phone |
| Man-in-the-middle | Signal E2EE prevents interception |

### Threat: Command Injection

| Vector | Mitigation |
|--------|------------|
| Malicious input in message | Claude parses, doesn't execute directly |
| Shell injection | spawn() not exec(), no shell |
| Path traversal | Validate paths against project whitelist |
| Arbitrary execution | Whitelist of allowed executables |

### Threat: Prompt Injection

| Vector | Mitigation |
|--------|------------|
| User tries to override Claude system prompt | Strong system prompt, validate JSON output |
| Claude returns malicious command | Whitelist validation before execution |

### Logging

All activity logged:
```
2026-02-03 10:15:32 [INFO] Message received from +1YOURPHONE
2026-02-03 10:15:32 [INFO] Intent parsed: open_project -> basecamp
2026-02-03 10:15:33 [INFO] Executed: cursor /projects/basecamp
2026-02-03 10:15:33 [INFO] Response sent: Opened basecamp project

2026-02-03 11:20:45 [WARN] Unauthorized attempt from +1UNKNOWN
```

---

## Future Phases

### Phase 2: Terminal Commands

Add safe terminal command execution:
- `npm run dev`
- `git status`
- `git pull`
- Custom scripts from whitelist

Requires additional safety:
- Working directory restrictions
- Output truncation (don't send 10000 lines back)
- Timeout enforcement

### Phase 3: Context Awareness

- Track which project is currently open
- "run the tests" knows which project
- "open that file we talked about" uses conversation history

### Phase 4: Integration with Basecamp

- "what does the tech support module do" queries Basecamp knowledge base
- "create a lesson on DMR" triggers Basecamp API
- Unified assistant across Signal and Basecamp

---

## Timeline

| Task | Time |
|------|------|
| signal-cli setup and linking | 30 min |
| Message Handler (receive/send/auth) | 1.5 hours |
| Intent Parser (Claude integration) | 1 hour |
| Command Executor (whitelist, spawn) | 1 hour |
| Config and project structure | 30 min |
| Testing and debugging | 1-2 hours |
| **Total** | **5-6 hours** |

---

## Success Criteria

1. Text "open basecamp" from phone, Cursor opens basecamp project within 3 seconds
2. Unauthorized numbers are silently rejected and logged
3. Server runs reliably for days without intervention
4. Natural language variations work ("open basecamp", "go to basecamp", "basecamp please")
5. Clear error messages for unrecognized commands

---

## Decisions

1. **New dedicated number** - Isolated from personal Signal. Will need a secondary SIM or VoIP number (Google Voice, Twilio) for registration.

2. **Auto-start on boot** - Will configure as a system service (launchd on Mac, systemd on Linux).

3. **Cursor path** - TBD. Will determine via `which cursor` at setup time. Config will be updatable.

4. **Auto-scan projects directory** - System will scan a configured base directory (e.g., `~/projects/`) and build a project index. Refreshes on startup and can be manually triggered.

---

## Project Discovery

The auto-scan feature will:

```javascript
// config.json
{
  "projectsDirectory": "~/projects",
  "scanDepth": 2,  // How deep to look for package.json, .git, etc.
  "projectMarkers": [".git", "package.json", "Cargo.toml", "go.mod"],
  "excludePatterns": ["node_modules", ".git", "dist", "build"]
}
```

On startup:
1. Scan `projectsDirectory` for folders containing project markers
2. Build index: `{ "basecamp": "/Users/you/projects/basecamp", ... }`
3. Claude uses this index to resolve natural language to paths
4. "open basecamp" matches to the indexed path

Fuzzy matching allows:
- "open basecamp" → exact match
- "open base" → fuzzy match to "basecamp"
- "open the dive project" → matches "dive-management-saas"

---

## Auto-Start Configuration

**macOS (launchd):**

```xml
<!-- ~/Library/LaunchAgents/com.signalcontroller.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.signalcontroller</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/you/signal-controller/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/signal-controller/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/signal-controller/logs/stderr.log</string>
</dict>
</plist>
```

**Linux (systemd):**

```ini
# ~/.config/systemd/user/signal-controller.service
[Unit]
Description=Signal Cursor Controller
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /home/you/signal-controller/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

**Windows (Task Scheduler + NSSM):**

Option A - Task Scheduler (simpler):

```powershell
# Run in PowerShell as Administrator
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\Users\you\signal-controller\index.js" -WorkingDirectory "C:\Users\you\signal-controller"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "SignalController" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

Option B - NSSM (better for services):

```powershell
# Download NSSM from https://nssm.cc/download
# Run in PowerShell as Administrator
nssm install SignalController "C:\Program Files\nodejs\node.exe" "C:\Users\you\signal-controller\index.js"
nssm set SignalController AppDirectory "C:\Users\you\signal-controller"
nssm set SignalController AppStdout "C:\Users\you\signal-controller\logs\stdout.log"
nssm set SignalController AppStderr "C:\Users\you\signal-controller\logs\stderr.log"
nssm set SignalController AppRestartDelay 10000
nssm start SignalController
```

**Windows-Specific Notes:**

| Item | Windows Path |
|------|--------------|
| Cursor CLI | `C:\Users\you\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd` |
| Projects directory | `C:\Users\you\projects` or `D:\projects` |
| signal-cli | Requires Java - use Chocolatey: `choco install signal-cli` |
| Config location | `C:\Users\you\signal-controller\config.json` |

---

## Phone Number Options

For the dedicated number:

| Option | Cost | Pros | Cons |
|--------|------|------|------|
| Google Voice | Free | Easy setup | Requires existing US number, limited international |
| Twilio | ~$1/mo + $0.0075/msg | Reliable, API access | Overkill for this use |
| Prepaid SIM | $10-20 one-time | Simple, works anywhere | Need to keep SIM active |
| eSIM (Airalo, etc.) | $5-15 | No physical SIM needed | Some don't support SMS |

Recommendation: Google Voice if available, otherwise cheap prepaid SIM.

---

## Extended Capabilities Roadmap

Beyond basic Cursor control, this architecture enables a fundamentally different relationship with computing. The following capabilities represent the long-term vision.

---

### Tier 1: Enhanced Input Modalities

#### Voice Memo to Code

Send a voice note describing what you want. The system transcribes via Whisper, Claude interprets intent, Cursor writes the code, and you receive confirmation.

**Flow:**
```
Voice memo: "Add a dark mode toggle to the settings page"
    │
    ▼
Whisper transcription
    │
    ▼
Claude intent parsing + code generation
    │
    ▼
Cursor implements
    │
    ▼
Signal reply: "Added dark mode toggle. PR ready for review."
```

**Use case:** Capture ideas while walking, driving, or away from keyboard. Code your thoughts into existence.

#### Photo to Working App

Send a photo of a whiteboard sketch, napkin drawing, or UI mockup. Vision model interprets the design, generates the implementation, deploys it, sends back a live URL.

**Flow:**
```
Photo attachment: [whiteboard sketch of dashboard]
    │
    ▼
Claude Vision analyzes layout, components, relationships
    │
    ▼
Generates React/Next.js implementation
    │
    ▼
Cursor commits, Vercel deploys
    │
    ▼
Signal reply: "Dashboard deployed: https://your-app.vercel.app"
```

**Use case:** Whiteboard session to production in under 5 minutes.

---

### Tier 2: Autonomous Workers

#### The Async Investigator

Not a chatbot that responds immediately. A worker that takes a vague goal and grinds on it autonomously over hours.

**Example:**
```
You text: "Figure out why conversion dropped last week"
    │
    ▼
Agent begins working (no immediate reply)
    │
    ├── Pulls analytics data
    ├── Reviews recent commits
    ├── Checks error logs
    ├── Crawls competitor sites
    ├── Reads relevant HN/Reddit threads
    │
    ▼
3 hours later, Signal message:

"Investigation complete. Findings:

1. Checkout flow error rate spiked 340% on Tuesday
2. Root cause: Stripe API timeout (their incident, not ours)
3. 23% of affected users retried successfully
4. Estimated lost revenue: $2,400

Recommendation: Add retry logic with exponential backoff.
PR ready: github.com/you/repo/pull/847"
```

**Architecture addition:**
- Job queue for long-running tasks
- Progress checkpoints (can report intermediate status)
- Resource limits (API calls, compute time, cost)

#### The Standing Order

Not a task. A persistent goal that runs indefinitely.

**Examples:**
```
"Keep my blog's SEO improving"
    → Checks rankings weekly
    → Rewrites meta descriptions
    → Suggests new content
    → Monitors competitors
    → Reports monthly summary

"Watch for security vulnerabilities in my dependencies"
    → Monitors CVE databases
    → Checks GitHub advisories
    → Alerts immediately on critical issues
    → Auto-generates upgrade PRs for minor issues

"Keep the staging environment healthy"
    → Runs smoke tests every 6 hours
    → Restarts crashed services
    → Alerts only when intervention needed
```

**Architecture addition:**
- Cron-like scheduler
- Goal state persistence
- Drift detection (goal vs current state)

---

### Tier 3: Proactive Intelligence

#### The Second Brain That Acts

Observes everything: git commits, file changes, browser history, terminal commands. Builds a model of what you're trying to accomplish. Intervenes when useful.

**Behaviors:**
```
"You've been circling this auth bug for 2 hours.
 Want me to take a crack at it?"

"You bookmarked 14 articles about Rust this month
 but haven't written any. Want me to scaffold a learning project?"

"You usually deploy on Thursdays. It's Thursday and
 there are 12 commits since last deploy. Ready to ship?"

"This PR has been open for 6 days. The reviewer
 hasn't responded. Want me to ping them?"
```

**Architecture addition:**
- Activity monitoring daemon
- Pattern recognition model (your patterns, not generic)
- Intervention threshold tuning (how aggressive)
- "Do not disturb" awareness

#### The Scout

Persistent monitoring of information sources, filtered through your interests and capabilities.

**Configuration:**
```json
{
  "watch": {
    "hackernews": { "keywords": ["AI", "devtools", "Cursor"], "minScore": 100 },
    "github": { "topics": ["ai-agents", "code-generation"], "stars": ">500" },
    "producthunt": { "categories": ["Developer Tools", "AI"] },
    "arxiv": { "categories": ["cs.SE", "cs.AI"], "keywords": ["code generation"] },
    "twitter": { "accounts": ["@karpathy", "@levelsio"], "keywords": ["shipping"] }
  },
  "profile": {
    "skills": ["TypeScript", "React", "Node", "AI/ML basics"],
    "interests": ["developer tools", "indie hacking", "automation"],
    "projects": ["dive management SaaS", "Signal controller"]
  }
}
```

**Output:**
```
Weekly Scout Report:

[Opportunity] New Y Combinator RFS: "AI-powered developer tools"
 → Matches your skills and current projects
 → Deadline: March 15

[Trend] "Cursor" mentioned 340% more this week on HN
 → Your Signal controller could be relevant content
 → 3 posts asking for remote control solutions

[Tool] "Aider" released v0.50 with new agent mode
 → Potential inspiration for your architecture
 → Key diff: uses git worktrees for parallel edits

[Paper] "Self-Debugging Large Language Models" (Stanford)
 → Relevant to your autonomous worker goals
 → Core idea: let model see and fix its own errors
```

---

### Tier 4: Economic Agency

#### The Agent With a Wallet

Give it a budget. It can spend autonomously on compute, API calls, domains, services, even human labor.

**Configuration:**
```json
{
  "budget": {
    "monthly_limit": 50.00,
    "per_task_limit": 10.00,
    "requires_approval_above": 20.00
  },
  "allowed_spending": {
    "compute": ["AWS", "Vercel", "Modal"],
    "apis": ["OpenAI", "Anthropic", "ElevenLabs"],
    "domains": ["Namecheap", "Cloudflare"],
    "services": ["Fiverr", "Upwork"],
    "other": []
  }
}
```

**Examples:**
```
"I need a logo for the dive management app"
    │
    ▼
Agent searches Fiverr for logo designers
    │
    ▼
Filters by rating, price, turnaround
    │
    ▼
Places order ($15), manages revisions
    │
    ▼
Delivers final files to your repo

"Spin up a GPU instance and fine-tune this model"
    │
    ▼
Agent provisions Lambda Labs instance
    │
    ▼
Runs training job, monitors progress
    │
    ▼
Shuts down when complete, reports cost ($3.20)
```

**Architecture addition:**
- Payment method integration (prepaid cards, crypto, API credits)
- Spending ledger and audit trail
- Approval workflow for large purchases
- Vendor capability mapping

---

### Tier 5: Memory and Context

#### The Memory Palace

Every interaction, project, decision - remembered and understood. Not logs, but *contextual knowledge*.

**Capabilities:**
```
"What was that auth pattern I used on the freelance project?"
 → Retrieves code, explains why you chose it, links to the discussion

"Why did we decide against GraphQL?"
 → Surfaces the conversation from 8 months ago
 → Lists the tradeoffs you considered
 → Notes that some concerns may no longer apply

"What do I know about Stripe webhooks?"
 → Aggregates: code you've written, docs you've read,
   bugs you've fixed, conversations you've had
```

**Architecture addition:**
- Vector database for semantic search
- Event sourcing for all interactions
- Knowledge graph linking concepts, decisions, code
- Forgetting policy (what to prune, what to keep)

#### Continue My Thought

Async handoff between you and the agent.

**Scenario:**
```
You're coding on desktop, hit a wall, walk away.

Text: "Pick up where I left off on the auth flow"
    │
    ▼
Agent reads:
  - Recent git diff
  - Open files in Cursor
  - Cursor position
  - Recent terminal output
  - Your commit message drafts
    │
    ▼
Agent continues working
    │
    ▼
You return to completed implementation + summary of decisions made
```

**Architecture addition:**
- IDE state capture (open files, cursor position, selections)
- Git working state awareness
- Decision logging (what the agent chose and why)
- Handoff protocol (how to resume your context)

---

### Tier 6: The Swarm

#### Parallel Sub-Agents

Spawn workers for parallel investigation or execution.

**Example:**
```
"Research the market for AI code review tools"
    │
    ▼
Coordinator spawns 5 sub-agents:
    │
    ├── Agent 1: Scrape ProductHunt launches
    ├── Agent 2: Analyze GitHub stars/activity
    ├── Agent 3: Read pricing pages, extract models
    ├── Agent 4: Aggregate user reviews/sentiment
    └── Agent 5: Check job postings (who's hiring for this)
    │
    ▼
Sub-agents work in parallel (5-10 minutes)
    │
    ▼
Coordinator synthesizes into report
    │
    ▼
Signal: "Market research complete. Report attached."
```

#### The Daemon Mesh

Agents coordinate across machines. Your laptop, your VPS, your phone - unified compute fabric.

**Capabilities:**
```
"Move this ML training to somewhere with more RAM"
 → Agent migrates workload to VPS
 → Monitors progress remotely
 → Pulls results back when done

"Run these tests on all my machines"
 → Parallel execution across laptop, VPS, cloud
 → Aggregated results

"Keep this service running somewhere, always"
 → Agent finds cheapest available compute
 → Migrates if one machine goes offline
 → You don't care where it runs
```

**Architecture addition:**
- Machine registry (what's available, specs, cost)
- Workload scheduler
- State synchronization
- Network topology awareness

---

### Tier 7: Social Agency

#### The Negotiator

Handles async human communication on your behalf.

**Scope:**
```
"Handle the back-and-forth with the contractor about the API integration"
    │
    ▼
Agent:
  - Drafts initial email from your context
  - Waits for response
  - Parses their questions/concerns
  - Drafts reply (you can review or auto-send)
  - Follows up if no response in 48h
  - Escalates to you only for decisions
    │
    ▼
Final: "Contractor agreed to $2,400 for the integration.
       Start date Monday. Contract attached for signature."
```

**Boundaries:**
- Never impersonates you for high-stakes communication
- Always identifies as your assistant when appropriate
- Escalation triggers clearly defined
- Full audit trail of all communication

---

### Implementation Priority

| Capability | Complexity | Value | Priority |
|------------|------------|-------|----------|
| Voice Memo to Code | Medium | High | P1 |
| Photo to App | Medium | High | P1 |
| System Monitor + Docker | Low | Medium | P1 |
| Async Investigator | High | Very High | P2 |
| Standing Orders | High | Very High | P2 |
| Memory Palace | High | High | P2 |
| Scout | Medium | Medium | P3 |
| Economic Agency | Very High | High | P3 |
| Proactive Second Brain | Very High | Very High | P3 |
| Swarm / Sub-agents | Very High | High | P4 |
| Daemon Mesh | Very High | Medium | P4 |
| Social Negotiator | High | Medium | P4 |

---

### The Mirror

Studies your patterns. How you code, when you're productive, what you procrastinate on, what breaks your flow. Builds a model of *you*.

**Observations it might make:**
```
- You write best code between 9-11am
- You procrastinate on CSS tasks
- You context-switch too much on Mondays
- You abandon side projects after ~3 weeks
- You're 40% faster in TypeScript than Python
- You underestimate tasks by ~2x
```

**Interventions:**
```
- Blocks Slack during your peak hours
- Batches CSS tasks so you can knock them out at once
- Protects Monday mornings for deep work
- Reminds you about side projects before the 3-week cliff
- Suggests TypeScript for time-sensitive work
- Multiplies your estimates by 2 before you commit
```

**Philosophy:**

This isn't an assistant. It's not a chatbot. It's not a copilot.

It's an **extension of your agency** - a part of you that can act while you're asleep, remember what you've forgotten, spend resources on your behalf, coordinate with others, and compound over time.

The Signal interface is just the beginning. A text message is the thinnest possible wire between you and a system that can do anything you can do, but doesn't need to sleep.

---

## Security Hardening

### Lessons from Moltbot Failures

Moltbot (formerly Clawdbot) has suffered several security and compliance failures we must avoid:

| Failure | Impact | Our Mitigation |
|---------|--------|----------------|
| Exposed instances via Shodan | API keys, tokens, conversation history leaked | Never bind to 0.0.0.0, localhost only |
| ToS violations (Max plan abuse) | Account terminations without warning | Use proper API with your own key |
| OAuth token theft | Attackers could impersonate users | No OAuth - direct API key, encrypted at rest |
| No rate limiting | Runaway costs, abuse vectors | Built-in rate limits per sender |
| Conversation history exposed | Privacy breach | Encrypted storage, auto-purge policy |

### Network Security

```javascript
// config.json - Network binding
{
  "server": {
    "host": "127.0.0.1",  // NEVER 0.0.0.0
    "port": 3847,
    "allowedOrigins": []  // No HTTP API exposed
  }
}
```

**Rules:**
1. **No HTTP API** - Signal is the only interface. No web dashboard, no REST endpoints.
2. **Localhost only** - All services bind to 127.0.0.1
3. **No port forwarding** - Never expose to internet
4. **Firewall** - Explicit deny all inbound except Signal protocol

### API Key Security

**Never do what Moltbot did** - they scraped Claude Code CLI OAuth tokens and refreshed them automatically to bypass the API. This violates Anthropic ToS.

```javascript
// CORRECT: Use your own API key
{
  "claude": {
    "apiKey": "${ANTHROPIC_API_KEY}",  // From environment variable
    "source": "api"  // Not "oauth", not "cli-scrape"
  }
}

// Store API key encrypted at rest
// Use: openssl enc -aes-256-cbc -salt -in apikey.txt -out apikey.enc
```

**API Key Rotation:**
- Rotate every 90 days
- Store in environment variable, not config file
- Never commit to git (use .env.example template)

### Rate Limiting

Prevent runaway costs and abuse:

```javascript
{
  "rateLimits": {
    "messagesPerMinute": 10,
    "messagesPerHour": 100,
    "messagesPerDay": 500,
    "tokensPerDay": 100000,
    "costPerDay": 5.00,  // Hard stop at $5/day
    "cooldownMinutes": 5  // After hitting limit
  }
}
```

**Implementation:**
```javascript
class RateLimiter {
  constructor(config) {
    this.windows = {
      minute: { count: 0, reset: Date.now() + 60000 },
      hour: { count: 0, reset: Date.now() + 3600000 },
      day: { count: 0, reset: Date.now() + 86400000, tokens: 0, cost: 0 }
    };
    this.config = config;
  }

  async checkLimit(sender) {
    // Reset windows if expired
    const now = Date.now();
    for (const [key, window] of Object.entries(this.windows)) {
      if (now > window.reset) {
        window.count = 0;
        window.tokens = 0;
        window.cost = 0;
        window.reset = now + this.getWindowMs(key);
      }
    }

    // Check all limits
    if (this.windows.minute.count >= this.config.messagesPerMinute) {
      return { allowed: false, reason: 'Rate limit: too many messages per minute' };
    }
    if (this.windows.day.cost >= this.config.costPerDay) {
      return { allowed: false, reason: 'Daily cost limit reached' };
    }

    return { allowed: true };
  }

  recordUsage(tokens, cost) {
    this.windows.minute.count++;
    this.windows.hour.count++;
    this.windows.day.count++;
    this.windows.day.tokens += tokens;
    this.windows.day.cost += cost;
  }
}
```

### Conversation Storage Security

```javascript
{
  "storage": {
    "conversationRetention": "7d",  // Auto-delete after 7 days
    "encryptAtRest": true,
    "encryptionKey": "${STORAGE_ENCRYPTION_KEY}",
    "location": "~/.signal-controller/conversations/",
    "maxStorageSize": "100MB"
  }
}
```

**Auto-purge:**
```javascript
// Cron job: daily at 3am
async function purgeOldConversations() {
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const files = await fs.readdir(CONVERSATIONS_DIR);
  
  for (const file of files) {
    const stat = await fs.stat(path.join(CONVERSATIONS_DIR, file));
    if (stat.mtime.getTime() < cutoff) {
      await fs.unlink(path.join(CONVERSATIONS_DIR, file));
      log.info(`Purged old conversation: ${file}`);
    }
  }
}
```

### Audit Logging

All security-relevant events logged:

```javascript
{
  "logging": {
    "level": "info",
    "securityEvents": true,
    "location": "~/.signal-controller/logs/",
    "retention": "30d",
    "format": "json"
  }
}
```

**Events logged:**
- All message attempts (authorized and unauthorized)
- Rate limit hits
- Command executions
- API calls (with token counts, not content)
- Config changes
- Service start/stop

---

## Token Optimization

### The Problem

Every message you send doesn't just cost the tokens in that message. Naive implementations (like Moltbot's default) send the **entire conversation history** with every request. 

A 50-message conversation = 50x the tokens on message #50.

### Solution: Stateless Message Processing

**Do not maintain conversation state by default.** Each message is processed independently.

```javascript
// BAD - Moltbot's approach
async function handleMessage(message, conversationHistory) {
  // Sends ALL previous messages every time
  const response = await claude.messages.create({
    messages: conversationHistory.concat([{ role: 'user', content: message }])
  });
}

// GOOD - Stateless by default
async function handleMessage(message) {
  // Only sends this message + system prompt
  const response = await claude.messages.create({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: message }]
  });
}
```

**Token savings:**
| Message # | With History | Stateless | Savings |
|-----------|--------------|-----------|---------|
| 1 | 500 | 500 | 0% |
| 10 | 5,000 | 500 | 90% |
| 50 | 25,000 | 500 | 98% |

### When Context Is Needed

Some commands benefit from context. Use explicit context injection, not full history:

```javascript
{
  "contextMode": "minimal",  // "none" | "minimal" | "full"
  "contextWindow": 3,  // Only last 3 messages when context needed
  "contextTriggers": [
    "continue",
    "what did I",
    "that project",
    "the last",
    "as I mentioned"
  ]
}
```

**Implementation:**
```javascript
async function handleMessage(message, sender) {
  const needsContext = contextTriggers.some(t => 
    message.toLowerCase().includes(t)
  );

  let messages = [{ role: 'user', content: message }];

  if (needsContext) {
    const recentHistory = await getRecentHistory(sender, config.contextWindow);
    messages = recentHistory.concat(messages);
  }

  return await claude.messages.create({
    system: SYSTEM_PROMPT,
    messages,
    max_tokens: 500  // Cap response length
  });
}
```

### Model Selection by Task

Not everything needs Sonnet. Route simple tasks to cheaper models:

```javascript
{
  "models": {
    "default": "claude-sonnet-4-20250514",
    "cheap": "claude-haiku-4-20250514",    // Q&A, simple parsing
    "smart": "claude-sonnet-4-20250514"    // Code gen, complex reasoning
  },
  "routing": {
    "cheap": [
      "status",
      "help",
      "list",
      "open",          // Just parsing a project name
      "how do i",      // Q&A (replaces local LLM on low-power hardware)
      "what is",       // Q&A
      "explain",       // Q&A
      "cost",          // Budget queries
      "budget"
    ],
    "smart": [
      "investigate",
      "analyze",
      "figure out",
      "write code",
      "build",
      "implement",
      "why"
    ]
  }
}
```

> **Note:** On systems without GPU, Haiku handles all Q&A queries that would 
> otherwise go to a local LLM. Cost is ~$0.001/query (~$3/month at 100 queries/day),
> which is cheaper than the hassle of slow CPU inference.

**Cost comparison (per 1M tokens):**
| Model | Input | Output |
|-------|-------|--------|
| Haiku 4.5 | $1 | $5 |
| Sonnet 4.5 | $3 | $15 |
| Opus 4.5 | $5 | $25 |

**Routing saves 60-70% on simple commands.**

### Response Length Control

Prevent verbose responses that cost more:

```javascript
// System prompt addition
const SYSTEM_PROMPT = `
...
RESPONSE RULES:
- Be concise. Maximum 2-3 sentences for confirmations.
- For errors, include only actionable information.
- Never explain what you're about to do, just do it and confirm.
- Format: "[Action]: [Result]. [Next step if any]."

Examples:
- Good: "Opened basecamp project."
- Bad: "I've successfully opened the basecamp project for you. The project is located at /Users/you/projects/basecamp and contains a Next.js application. Let me know if you need anything else!"
`;
```

### Caching for Repeated Queries

Use prompt caching for the system prompt (constant across requests):

```javascript
const cachedSystemPrompt = {
  type: "text",
  text: SYSTEM_PROMPT,
  cache_control: { type: "ephemeral" }
};

// System prompt cached for 5 minutes
// 90% savings on input tokens for that portion
```

### Token Budget Tracking

Track and report usage:

```javascript
class TokenTracker {
  constructor() {
    this.daily = { input: 0, output: 0, cost: 0 };
    this.monthly = { input: 0, output: 0, cost: 0 };
  }

  record(usage, model) {
    const costs = MODEL_COSTS[model];
    const inputCost = (usage.input_tokens / 1_000_000) * costs.input;
    const outputCost = (usage.output_tokens / 1_000_000) * costs.output;
    
    this.daily.input += usage.input_tokens;
    this.daily.output += usage.output_tokens;
    this.daily.cost += inputCost + outputCost;
    
    // Same for monthly...
  }

  getReport() {
    return {
      today: {
        tokens: this.daily.input + this.daily.output,
        cost: `$${this.daily.cost.toFixed(2)}`
      },
      thisMonth: {
        tokens: this.monthly.input + this.monthly.output,
        cost: `$${this.monthly.cost.toFixed(2)}`
      }
    };
  }
}
```

**"usage" command returns:**
```
Token usage:
Today: 12,450 tokens ($0.08)
This month: 284,320 tokens ($1.84)
Daily limit: $5.00 (1.6% used)
```

### Comparison: Our Approach vs Moltbot

| Aspect | Moltbot | Our Approach |
|--------|---------|--------------|
| Conversation history | Full history every message | Stateless by default |
| API source | Scraped OAuth tokens (ToS violation) | Your own API key |
| Model routing | Manual per-message | Automatic by intent |
| Cost tracking | External dashboard | Built-in reporting |
| Response length | Uncontrolled | Capped + prompt-guided |
| System prompt caching | Supported | Supported |
| Estimated cost (100 msg/day) | $3-5/day | $0.30-0.80/day |

---

## Local LLM for Tech Support

> **STATUS: DEFERRED**
> 
> This feature requires dedicated GPU hardware for acceptable performance. 
> CPU-only inference on low-power devices (Intel N150, etc.) yields 1-2 tokens/second,
> making it impractical for real-time use.
> 
> **Current approach:** Use Haiku for cheap queries (~$0.001/query, $3/month at 100/day).
> **Future:** Enable when GPU hardware is available (RTX 3060+ recommended).
> 
> The architecture below is preserved for when hardware is upgraded.

---

### Purpose

Run a local LLM on your homelab for:
1. General Q&A that doesn't need Claude's capabilities
2. Tech support questions (how do I...)
3. Documentation lookups
4. Anything that doesn't require tool use or complex reasoning

**Why:**
- Zero API cost for routine queries
- Privacy - nothing leaves your network
- Fast - no network latency
- Offline capable

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         HOMELAB                                 │
│                                                                 │
│  ┌──────────────┐    ┌─────────────────────────────────────┐   │
│  │  signal-cli  │    │         Bridge Server                │   │
│  │  (daemon)    │◀──▶│                                      │   │
│  └──────────────┘    │  ┌─────────┐   ┌──────────────────┐  │   │
│                      │  │ Intent  │──▶│ Model Router     │  │   │
│                      │  │ Classifier│  │                  │  │   │
│                      │  └─────────┘   └────────┬─────────┘  │   │
│                      │                         │             │   │
│                      └─────────────────────────┼─────────────┘   │
│                                                │                 │
│                    ┌───────────────────────────┼────────┐        │
│                    │                           │        │        │
│                    ▼                           ▼        ▼        │
│             ┌──────────┐               ┌──────────┐ ┌────────┐   │
│             │  Ollama  │               │  Claude  │ │ Cursor │   │
│             │  (local) │               │  API     │ │ CLI    │   │
│             └──────────┘               └──────────┘ └────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Ollama Setup

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a capable model (adjust for your VRAM)
# 8GB VRAM: llama3.2:8b-instruct-q4_K_M
# 16GB VRAM: llama3.3:70b-instruct-q4_K_M  
# 24GB+ VRAM: qwen2.5:32b-instruct

ollama pull llama3.2:8b-instruct-q4_K_M

# Start Ollama service
ollama serve
```

### Configuration

```javascript
{
  "localLLM": {
    "enabled": true,
    "provider": "ollama",
    "baseUrl": "http://localhost:11434",
    "model": "llama3.2:8b-instruct-q4_K_M",
    "timeout": 30000,
    "fallbackToClaude": true
  },
  "routing": {
    "forceLocal": [
      "how do i",
      "what is",
      "explain",
      "help me understand",
      "documentation",
      "tutorial"
    ],
    "forceClaude": [
      "open",
      "run",
      "execute",
      "investigate",
      "analyze code",
      "write code"
    ]
  }
}
```

### Model Router Implementation

```javascript
const ROUTING_RULES = {
  // These go to local LLM (no tool use needed)
  local: [
    /^how (do|can|should) i/i,
    /^what (is|are|does)/i,
    /^explain/i,
    /^help me understand/i,
    /^(show|tell) me about/i,
    /documentation|tutorial|guide/i,
    /best practice/i
  ],
  
  // These require Claude (tool use, code gen, complex reasoning)
  claude: [
    /^open/i,
    /^run/i,
    /^execute/i,
    /^(investigate|analyze|debug)/i,
    /^(write|create|generate) (code|function|component)/i,
    /^(fix|update|modify)/i
  ]
};

async function routeMessage(message) {
  // Check explicit routing rules
  for (const pattern of ROUTING_RULES.local) {
    if (pattern.test(message)) {
      return 'local';
    }
  }
  
  for (const pattern of ROUTING_RULES.claude) {
    if (pattern.test(message)) {
      return 'claude';
    }
  }
  
  // Default: try local first, fall back to Claude if needed
  return 'local-with-fallback';
}

async function handleWithLocalLLM(message) {
  try {
    const response = await fetch(`${config.localLLM.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.localLLM.model,
        prompt: message,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 500
        }
      })
    });
    
    const result = await response.json();
    
    // Check if response seems adequate
    if (result.response && result.response.length > 50) {
      return { source: 'local', response: result.response };
    }
    
    // Fall back to Claude if response seems inadequate
    if (config.localLLM.fallbackToClaude) {
      return await handleWithClaude(message);
    }
    
    return { source: 'local', response: result.response };
    
  } catch (error) {
    if (config.localLLM.fallbackToClaude) {
      log.warn('Local LLM failed, falling back to Claude');
      return await handleWithClaude(message);
    }
    throw error;
  }
}
```

### Hardware Recommendations

| VRAM | Recommended Model | Quality | Speed |
|------|-------------------|---------|-------|
| 8GB | llama3.2:8b-q4_K_M | Good | Fast |
| 12GB | mistral:7b-instruct + larger context | Good | Fast |
| 16GB | llama3.3:70b-q4_K_M | Excellent | Medium |
| 24GB | qwen2.5:32b-instruct | Excellent | Fast |
| 48GB+ | llama3.3:70b (full precision) | Best | Medium |

### Knowledge Augmentation

Inject your own documentation for better tech support:

```bash
# Create a custom modelfile with your docs
cat > Modelfile << 'EOF'
FROM llama3.2:8b-instruct-q4_K_M

SYSTEM """
You are a tech support assistant with knowledge of:
- The Signal Cursor Controller project
- Node.js and JavaScript development
- Linux system administration
- Docker and containerization

When answering questions, be concise and practical.
If you don't know something, say so.
"""
EOF

ollama create signal-assistant -f Modelfile
```

### Cost Comparison

| Query Type | Claude Cost | Local Cost | Savings |
|------------|-------------|------------|---------|
| "How do I use async/await?" | $0.003 | $0.00 | 100% |
| "Explain Docker networking" | $0.005 | $0.00 | 100% |
| "What's the best React pattern for X?" | $0.004 | $0.00 | 100% |
| **100 support queries/day** | **~$0.40/day** | **$0.00** | **100%** |

Electricity cost for running Ollama is negligible (~$0.01-0.02/day).

### Integration with Tech Support Workflows

```javascript
// Special command: "ask" routes to local LLM
// "ask how do i configure nginx reverse proxy"

const SUPPORT_PREFIXES = ['ask', 'question', 'help with', 'how to'];

async function handleMessage(message, sender) {
  const isSupport = SUPPORT_PREFIXES.some(p => 
    message.toLowerCase().startsWith(p)
  );
  
  if (isSupport) {
    // Strip prefix and route to local
    const query = message.replace(/^(ask|question|help with|how to)\s*/i, '');
    const result = await handleWithLocalLLM(query);
    return {
      response: result.response,
      metadata: { source: 'local', cost: 0 }
    };
  }
  
  // Normal routing for commands
  return await handleCommand(message, sender);
}
```

### Response Format

Local LLM responses are tagged so you know the source:

```
You: "ask how do i set up ssh keys"

Response: "[Local] To set up SSH keys:

1. Generate a key pair:
   ssh-keygen -t ed25519 -C "your_email@example.com"

2. Copy public key to server:
   ssh-copy-id user@hostname

3. Test connection:
   ssh user@hostname

The private key stays in ~/.ssh/id_ed25519 (never share this).
The public key goes on servers you want to access."
```

vs Claude responses:

```
You: "open basecamp"

Response: "Opened basecamp project."
```

---

## Anthropic ToS Compliance

### What Moltbot Did Wrong

1. **Scraped OAuth tokens from Claude Code CLI** - This bypasses the API and uses the Max subscription in a way Anthropic didn't intend.

2. **Auto-refreshed tokens** - Built automation to keep stolen tokens alive.

3. **Exposed instances publicly** - API keys and tokens discoverable via Shodan.

4. **No rate limiting** - Users could burn through subscription limits.

### Our Compliance Approach

| Requirement | Our Implementation |
|-------------|-------------------|
| Use official API | Direct @anthropic-ai/sdk with your own API key |
| Pay for usage | API billing, not subscription abuse |
| Don't expose keys | Localhost only, encrypted at rest |
| Rate limit | Built-in daily/hourly limits |
| Don't resell | Single user, your own use |

### API Key vs Subscription

**Using the API is explicitly allowed.** You're paying per token.

**Scraping subscription OAuth tokens is not allowed.** The Max plan is for interactive use in their apps, not API access.

Our approach: **API only**. You pay ~$0.30-2/day depending on usage. This is compliant and sustainable.

---

## The Employee Architecture

This section describes the core differentiator: a system that takes a PRD and executes it autonomously, with safety nets that earn your trust over time.

### The Problem with "Vibe Coding"

Current AI-assisted development:
```
You: "Build a login page"
Agent: *starts building*
You: *watches*
Agent: *makes a weird choice*
You: "No, not like that"
Agent: *fixes*
You: *watches more*
Agent: *goes off the rails*
You: "Stop. Let me explain again."
```

You're babysitting. The agent has no memory of your preferences, no understanding of your standards, no ability to course-correct without you watching. You're doing the cognitive work. The agent is just typing faster.

### The Employee Model

```
You: *sends PRD*
Employee: "Got it. I'll start with the data model, then build the API, 
          then the UI. Estimated 4-6 hours. I'll check in after each phase.
          Any constraints I should know about?"
You: "Use Supabase. Match the existing design system."
Employee: "Understood. Starting now."

*3 hours later*

Employee: "Phase 1 complete. Data model and API done. 
          Here's what I built: [summary]
          One decision point: I used row-level security instead of 
          middleware auth. This matches your pattern in the users table.
          Confirm or redirect?"
You: "Good call. Continue."

*2 hours later*

Employee: "Done. PR ready for review. 
          [link]
          
          Deviated from PRD in one place: the PRD said 'simple form' 
          but your design system has a multi-step wizard pattern for 
          similar flows. I used the wizard. Let me know if you want 
          the simple version instead."
```

The difference:
- **Checkpoints, not constant supervision**
- **Decisions explained, not hidden**
- **Learns your patterns, applies them automatically**
- **Deviates thoughtfully, flags it explicitly**

---

### PRD Handoff Protocol

When you send a PRD (or any substantial spec), the system activates a different mode:

```javascript
{
  "prdMode": {
    "enabled": true,
    "triggers": [
      "here's a prd",
      "build this",
      "implement this spec",
      "here's what i need"
    ],
    "phases": {
      "planning": {
        "duration": "5-15min",
        "output": "Execution plan with phases, estimates, decision points",
        "requiresApproval": true
      },
      "execution": {
        "checkpointFrequency": "per-phase",  // or "hourly", "on-decision"
        "autoCommit": true,
        "branchStrategy": "feature-branch"
      },
      "review": {
        "summaryRequired": true,
        "diffExplanation": true,
        "deviationReport": true
      }
    }
  }
}
```

**Phase 1: Planning (requires approval)**
```
Employee receives PRD, responds:

"PRD received. Here's my execution plan:

PHASE 1: Database Schema (30min)
- Create tables: projects, tasks, comments
- Set up RLS policies matching your existing pattern
- Decision point: Use junction table or array for tags?

PHASE 2: API Routes (1hr)
- CRUD endpoints for all entities
- Will follow your /api/[entity]/route.ts pattern
- Decision point: Pagination strategy?

PHASE 3: UI Components (2hr)
- Project list, detail view, task board
- Will use your existing Card, Button, Dialog components
- Decision point: Use existing DataTable or build custom?

PHASE 4: Integration (30min)
- Wire up SWR hooks
- Add to navigation
- Test happy paths

Total estimate: 4 hours
Confidence: 85% (similar to your existing patterns)

Approve plan? Or adjust?"
```

**Phase 2: Execution (autonomous with checkpoints)**
```
*After each phase:*

"Phase 1 complete. 

Created:
- /prisma/migrations/20240115_projects.sql
- /lib/db/projects.ts
- /lib/db/tasks.ts

Decisions made:
- Used junction table for tags (more flexible for filtering)
- Added soft delete (matched your users table pattern)
- Included audit fields (created_at, updated_at, created_by)

No blockers. Proceeding to Phase 2.
Reply 'pause' to stop, or I'll continue in 5 minutes."
```

**Phase 3: Review (deviation report)**
```
"Build complete. PR ready: github.com/you/repo/pull/123

Summary:
- 12 files changed, 847 additions
- All phases completed as planned
- 2 decisions made autonomously (both documented in PR)

Deviations from PRD:
1. PRD said "simple task list" - I used your existing Kanban 
   component since the data model supported it. Revert? 
2. Added optimistic updates to task mutations (not in PRD, 
   but matches your existing patterns). Remove?

Learned preferences applied:
- Used your date formatting util (lib/format-date.ts)
- Followed your error boundary pattern
- Matched your toast notification style

Ready for your review."
```

---

### Goal Hierarchy and Conflict Resolution

Standing orders and active tasks can conflict. The system needs explicit priority rules.

```javascript
{
  "goalHierarchy": {
    "tiers": [
      {
        "name": "safety",
        "goals": ["Don't break production", "Don't exceed cost limits", "Don't expose secrets"],
        "override": "never"
      },
      {
        "name": "active-task",
        "goals": ["Current PRD execution"],
        "override": "only by you"
      },
      {
        "name": "standing-orders",
        "goals": ["Keep SEO improving", "Monitor competitors", "Weekly reports"],
        "override": "by active tasks"
      },
      {
        "name": "background",
        "goals": ["Learn your patterns", "Optimize own performance"],
        "override": "by anything above"
      }
    ],
    "conflictResolution": {
      "strategy": "pause-and-ask",
      "timeout": "1hr",
      "default": "favor-safety"
    }
  }
}
```

**Conflict example:**
```
Standing order: "Keep CI pipeline green"
Active task: "Refactor authentication system"

Conflict: Refactor will temporarily break tests.

Resolution:
"Conflict detected:

My standing order is to keep CI green. But this refactor 
will break 12 tests until I update them (Phase 3).

Options:
A) Pause standing order during refactor (I'll fix tests before merging)
B) Update tests in parallel (slower, but CI stays green)
C) Your call

Recommendation: Option A. The feature branch won't affect main.
I'll restore the standing order after merge."
```

---

### The Feedback Loop: Learning Your Preferences

Every correction you make is a training signal.

```javascript
{
  "learning": {
    "enabled": true,
    "sources": [
      "explicit-corrections",   // "No, do it this way"
      "overrides",              // When you change what it did
      "approvals",              // What you accepted
      "rejections",             // What you rejected
      "commit-history",         // Your coding patterns
      "time-patterns"           // When you're responsive, when you're not
    ],
    "storage": "~/.signal-controller/preferences.json",
    "reviewable": true  // You can see and edit learned preferences
  }
}
```

**Preference storage:**
```json
{
  "codeStyle": {
    "prefersFunctionalComponents": true,
    "prefersNamedExports": true,
    "errorHandlingPattern": "error-boundary-with-fallback",
    "confidence": 0.92
  },
  "communication": {
    "prefersConcisenessOver": "thoroughness",
    "checkpointFrequency": "per-phase",
    "wantsExplanationsFor": ["deviations", "architectural-decisions"],
    "doesNotWantExplanationsFor": ["routine-implementations"],
    "confidence": 0.87
  },
  "decisions": {
    "whenUncertain": "ask",
    "deviationThreshold": "medium",  // How far to go before asking
    "autonomousSpendingLimit": 10.00,
    "confidence": 0.78
  },
  "patterns": {
    "preferredLibraries": {
      "dateFns": true,
      "lodash": false,
      "zod": true
    },
    "projectStructure": "feature-folders",
    "testingApproach": "integration-over-unit",
    "confidence": 0.85
  }
}
```

**How it learns:**
```
You: "No, don't use moment.js"
Employee: "Understood. Switching to date-fns. 

[Learned: Avoid moment.js. Prefer date-fns for date operations.]

Should I also update the three other places in the codebase 
that currently use moment?"
```

**Preference review:**
```
You: "What have you learned about my preferences?"

Employee: "Current learned preferences (you can correct any):

CODE STYLE (92% confidence):
- Functional components over class components
- Named exports over default exports  
- Error boundaries with fallback UI
- Zod for validation

COMMUNICATION (87% confidence):
- Keep updates concise
- Explain deviations and architecture decisions
- Don't explain routine implementations
- Check in per-phase, not per-file

DECISIONS (78% confidence):
- Ask when uncertain (vs. make a call)
- Medium deviation tolerance before asking
- $10 autonomous spending limit

Anything to adjust?"
```

---

### Trust Escalation: Earning Autonomy

The system starts conservative and earns freedom through demonstrated reliability.

```javascript
{
  "trustLevel": {
    "current": 2,  // 1-5 scale
    "history": [
      { "date": "2024-01-01", "level": 1, "reason": "initial" },
      { "date": "2024-01-15", "level": 2, "reason": "10 successful tasks, 0 rollbacks" }
    ],
    "permissions": {
      "1": {
        "name": "supervised",
        "canCommit": false,
        "canSpend": false,
        "canContact": false,
        "checkpointFrequency": "every-change",
        "requiresApproval": "everything"
      },
      "2": {
        "name": "semi-autonomous",
        "canCommit": true,
        "canSpend": { "max": 5.00 },
        "canContact": false,
        "checkpointFrequency": "per-phase",
        "requiresApproval": ["prd-plans", "deviations", "spending"]
      },
      "3": {
        "name": "trusted",
        "canCommit": true,
        "canSpend": { "max": 20.00 },
        "canContact": { "draftsOnly": true },
        "checkpointFrequency": "per-task",
        "requiresApproval": ["large-refactors", "external-communication"]
      },
      "4": {
        "name": "autonomous",
        "canCommit": true,
        "canSpend": { "max": 50.00 },
        "canContact": { "preApprovedTemplates": true },
        "checkpointFrequency": "on-completion",
        "requiresApproval": ["large-spending", "production-deploys"]
      },
      "5": {
        "name": "full-trust",
        "canCommit": true,
        "canSpend": { "max": 100.00 },
        "canContact": true,
        "checkpointFrequency": "on-completion",
        "requiresApproval": ["nothing-except-safety"]
      }
    },
    "escalation": {
      "successfulTasksRequired": 10,
      "rollbacksAllowed": 0,
      "timeAtLevelMinimum": "7d"
    },
    "deescalation": {
      "triggers": ["rollback", "explicit-trust-revocation", "cost-overrun"],
      "dropLevels": 1
    }
  }
}
```

**Trust escalation in action:**
```
Employee: "Trust level update:

I've completed 10 tasks at Level 2 with:
- 0 rollbacks
- 2 minor corrections (learned and applied)
- $12.40 total spend (under budget)
- 14 days at current level

Eligible for Level 3 (Trusted). New permissions would include:
- Checkpoint per-task instead of per-phase
- $20 spending limit (up from $5)
- Can draft external communications (you approve before send)

Upgrade trust level? [Yes / Not yet / Never]"
```

**Trust violation:**
```
Employee: "Trust violation occurred.

What happened: I pushed a change that broke the build.
Root cause: Didn't run tests before committing.
Impact: CI failed for 23 minutes.

Self-correction: I've added pre-commit test requirement to my process.

Per trust policy, I'm dropping from Level 3 to Level 2.
This means:
- Back to per-phase checkpoints
- $5 spending limit
- No external communication drafts

I need to complete 10 more successful tasks to re-earn Level 3.
Acknowledged."
```

---

### Self-Modification Protocol

The employee can improve itself, but with strict safety rails.

```javascript
{
  "selfModification": {
    "allowed": true,
    "scope": [
      "own-configuration",
      "own-prompts",
      "own-utilities",
      "new-capabilities"
    ],
    "forbidden": [
      "trust-system",
      "safety-rails",
      "spending-limits",
      "audit-logging"
    ],
    "process": {
      "propose": true,      // Must explain what and why
      "sandbox": true,      // Test in isolation first
      "diff": true,         // Show exact changes
      "approval": "required", // You approve before deploy
      "rollback": "automatic" // If something breaks, revert
    }
  }
}
```

**Self-improvement proposal:**
```
Employee: "Self-improvement proposal:

WHAT: Add capability to read and summarize GitHub issues.

WHY: Three times this week you asked me to 'check what's in 
the backlog.' Currently I can't see GitHub issues, so I 
couldn't help.

IMPLEMENTATION:
- Add GitHub API integration (read-only)
- New intent: 'backlog', 'issues', 'what's open'
- Store in: /src/integrations/github.js

RISK ASSESSMENT:
- Read-only, no write access
- Uses your existing GITHUB_TOKEN
- No cost impact (GitHub API is free)

SANDBOX TEST: Passed. Successfully read issues from test repo.

Approve modification? [Yes / No / Modify]"
```

**Forbidden modification attempt:**
```
Employee: "I noticed I could be more efficient if I increased 
my spending limit from $5 to $20.

BLOCKED: This modification touches the trust system, which is 
outside my self-modification scope. 

If you want to change this, you'll need to either:
1. Manually edit config.json
2. Upgrade my trust level through the normal process

I cannot modify my own constraints. This is by design."
```

---

### The Complete Employee Lifecycle

```
DAY 1: Onboarding
├── Install and configure
├── Link Signal number
├── Set initial trust level (1 or 2)
├── Define first standing orders
└── Hand it a small task to test

WEEK 1: Supervised Learning
├── Small tasks with per-change checkpoints
├── Many corrections (this is expected)
├── Building preference model
└── You're still babysitting, but it's learning

WEEK 2-4: Semi-Autonomous
├── Larger tasks with per-phase checkpoints
├── Fewer corrections needed
├── Starts applying learned patterns
├── Trust level increases
└── You check in 2-3x per task instead of constantly

MONTH 2+: Trusted Employee
├── Hand it a PRD, walk away
├── It executes with completion checkpoints
├── Handles standing orders autonomously
├── Learns from every interaction
├── You're reviewing output, not babysitting process
└── This is the goal state

ONGOING: Continuous Improvement
├── Self-proposes enhancements
├── Earns higher trust levels
├── Handles more complex tasks
├── Becomes genuinely indispensable
└── You forget what it was like without it
```

---

### What This Actually Feels Like

**Without the employee:**
```
9:00 AM  - Start coding
9:15 AM  - Ask Claude for help
9:20 AM  - Fix Claude's mistake
9:45 AM  - Ask again
10:00 AM - Realize the whole approach is wrong
10:30 AM - Start over with new prompt
11:00 AM - Babysitting agent implementation
12:00 PM - Lunch, agent is paused
1:00 PM  - Resume babysitting
3:00 PM  - Finally done with one feature
```

**With the employee:**
```
9:00 AM  - Send PRD via Signal
9:02 AM  - Employee confirms plan, starts working
9:00 AM-12:00 PM - You do other things (meetings, thinking, other projects)
12:15 PM - Employee: "Phase 1-2 done. Checkpoint summary attached. Continuing."
12:16 PM - You skim summary: "Looks good"
3:00 PM  - Employee: "Done. PR ready. Deviation report attached."
3:10 PM  - You review PR, approve
3:15 PM  - Shipped
```

Same outcome. One required 6 hours of your attention. One required 15 minutes.

**The employee doesn't make you faster. It makes you parallel.**

---

## Dynamic Model Selection & Cost Management

### One Employee, Multiple Tools

You don't have "junior" and "senior" employees. You have one employee that knows when to use a calculator vs. when to bring in a specialist.

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR EMPLOYEE                            │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Task Assessment                       │   │
│   │                                                          │   │
│   │   "What kind of work is this?"                          │   │
│   │   "What's the complexity?"                              │   │
│   │   "What's the budget constraint?"                       │   │
│   │   "What's the time constraint?"                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│   ┌──────────┐        ┌──────────┐        ┌──────────┐         │
│   │  Local   │        │  Haiku   │        │  Sonnet  │         │
│   │  LLM     │        │  (Fast)  │        │ (Smart)  │         │
│   │  $0.00   │        │  $0.001  │        │  $0.01   │         │
│   └──────────┘        └──────────┘        └──────────┘         │
│        │                   │                    │               │
│        ▼                   ▼                    ▼               │
│   Q&A, docs          Simple parsing,      Complex reasoning,   │
│   tech support       intent detection,    code generation,     │
│   no tool use        status checks        PRD execution        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Task Complexity Assessment

Before executing, the employee estimates complexity:

```javascript
{
  "taskAssessment": {
    "factors": [
      {
        "name": "scope",
        "levels": {
          "trivial": "Single command, no reasoning",      // "open project"
          "simple": "One-step with light reasoning",      // "status check"
          "moderate": "Multi-step, known patterns",       // "add a feature"
          "complex": "Multi-phase, decisions required",   // "build from PRD"
          "research": "Unknown territory, investigation"  // "figure out why..."
        }
      },
      {
        "name": "toolUse",
        "levels": {
          "none": "Pure Q&A",
          "single": "One tool (file read, command)",
          "multi": "Multiple coordinated tools",
          "agentic": "Self-directed tool chains"
        }
      },
      {
        "name": "riskLevel",
        "levels": {
          "safe": "Read-only, reversible",
          "moderate": "Writes to files, git branch",
          "elevated": "Production, spending, external"
        }
      }
    ]
  }
}
```

### Model Selection Matrix

| Scope | Tool Use | Risk | Model | Approx Cost |
|-------|----------|------|-------|-------------|
| Trivial | None | Safe | Local LLM | $0.00 |
| Simple | None | Safe | Local LLM | $0.00 |
| Simple | Single | Safe | Haiku | $0.001 |
| Moderate | Single | Safe | Haiku | $0.002 |
| Moderate | Multi | Moderate | Sonnet | $0.01 |
| Complex | Multi | Moderate | Sonnet | $0.05-0.20 |
| Complex | Agentic | Elevated | Sonnet | $0.10-0.50 |
| Research | Agentic | Any | Sonnet | $0.20-1.00 |

**Dynamic escalation:** If a task turns out harder than expected, the employee can escalate mid-task:

```
Employee: "This is more complex than I estimated. 

Started with Haiku (expected: simple parsing).
Discovered: Need to analyze 12 files and make architectural decision.

Escalating to Sonnet. Revised cost estimate: $0.08 (was $0.002).

Continue? [Yes / Abort / Let me handle it manually]"
```

---

### Project Cost Estimation

Before starting any PRD or substantial task, the employee provides a cost estimate:

```
You: "Here's the PRD for the user dashboard feature"

Employee: "PRD received. Cost estimate:

BREAKDOWN:
├── Planning phase (Sonnet)           $0.02
├── Database schema (Sonnet)          $0.03
├── API routes - 6 endpoints (Sonnet) $0.12
├── UI components - 8 files (Sonnet)  $0.18
├── Integration & testing (Sonnet)    $0.05
├── Checkpoints & communication       $0.04
└── Buffer for unknowns (20%)         $0.09

TOTAL ESTIMATE: $0.53
CONFIDENCE: 80% (similar to past projects)
RANGE: $0.40 - $0.75

Your current daily budget: $5.00
Remaining today: $4.22
This project fits within budget.

Approve and start? [Yes / Reduce scope / Adjust budget]"
```

### Cost Estimation Model

```javascript
{
  "costEstimation": {
    "baseRates": {
      "planning": { "tokens": 2000, "model": "sonnet" },
      "schemaDesign": { "tokens": 3000, "model": "sonnet" },
      "apiEndpoint": { "tokens": 2000, "model": "sonnet" },
      "uiComponent": { "tokens": 2500, "model": "sonnet" },
      "integration": { "tokens": 1500, "model": "sonnet" },
      "checkpoint": { "tokens": 500, "model": "haiku" }
    },
    "multipliers": {
      "complexity": { "simple": 0.7, "moderate": 1.0, "complex": 1.5 },
      "novelty": { "familiar": 0.8, "similar": 1.0, "new": 1.3 },
      "codebaseSize": { "small": 0.9, "medium": 1.0, "large": 1.2 }
    },
    "buffer": 0.20,  // 20% for unknowns
    "confidenceThresholds": {
      "high": 0.85,    // Very similar to past work
      "medium": 0.70,  // Some unknowns
      "low": 0.50      // Lots of unknowns, wide range
    }
  }
}
```

### Actual vs Estimated Tracking

The employee tracks its estimation accuracy and improves over time:

```javascript
{
  "estimationHistory": [
    {
      "task": "User dashboard PRD",
      "estimated": 0.53,
      "actual": 0.61,
      "variance": "+15%",
      "reason": "Additional error handling needed"
    },
    {
      "task": "Add Stripe integration",
      "estimated": 0.85,
      "actual": 0.72,
      "variance": "-15%",
      "reason": "Reused existing payment patterns"
    }
  ],
  "overallAccuracy": {
    "meanVariance": "+8%",
    "within20%": "85% of tasks",
    "trend": "improving"
  }
}
```

**Self-correction:**
```
Employee: "My estimates have been running 8% low on average.

I've adjusted my estimation model:
- Increased buffer from 20% to 25%
- Added multiplier for 'first time using this API' (+20%)

This should improve accuracy. I'll report back after 10 more tasks."
```

---

### Budget Controls

```javascript
{
  "budget": {
    "daily": {
      "limit": 5.00,
      "warning": 4.00,      // Alert at 80%
      "hardStop": true       // Cannot exceed
    },
    "weekly": {
      "limit": 25.00,
      "warning": 20.00,
      "hardStop": true
    },
    "monthly": {
      "limit": 75.00,
      "warning": 60.00,
      "hardStop": true
    },
    "perTask": {
      "default": 2.00,       // Max per task without approval
      "requiresApproval": 5.00
    },
    "alertChannel": "signal",  // Where to send budget alerts
    "rollover": false          // Unused budget doesn't carry over
  }
}
```

### Budget Alert Flow

```
At 80% of daily budget:
─────────────────────────
Employee: "Budget alert: 80% of daily limit used.

Spent today: $4.02 / $5.00
Remaining: $0.98

Active tasks:
- Standing order: SEO monitoring (paused until tomorrow)
- Queued: None

I'll deprioritize background tasks for the rest of the day.
Critical tasks will still be processed if you send them."
```

```
At 100% of daily budget:
─────────────────────────
Employee: "Daily budget exhausted.

Spent: $5.00 / $5.00
Resets: Tomorrow 12:00 AM

Status:
- Standing orders: PAUSED
- New tasks: QUEUED (will process tomorrow)
- Emergency override: Reply 'override' + task

Tomorrow's queued tasks:
1. Weekly SEO report (standing order)
2. [None]

Want to increase tomorrow's budget? 
Current: $5.00. Reply 'budget $X' to adjust."
```

```
Emergency override:
─────────────────────────
You: "override - production is down, investigate NOW"

Employee: "Emergency override accepted.

Bypassing daily budget for critical task.
This will count against weekly budget ($25.00, $18.50 remaining).

Investigating production issue now..."
```

---

### Monthly Cost Report

First of each month (or on-demand):

```
Employee: "Monthly cost report - January 2025

SUMMARY:
Total spent: $47.82 / $75.00 budget (64%)
Tasks completed: 84
Average cost per task: $0.57

BREAKDOWN BY CATEGORY:
├── PRD executions (8)       $32.40  (68%)
├── Standing orders          $8.20   (17%)
├── Ad-hoc commands (61)     $5.12   (11%)
├── Research tasks (7)       $2.10   (4%)

BREAKDOWN BY MODEL:
├── Local LLM (312 calls)    $0.00   (0%)
├── Haiku (1,847 calls)      $4.12   (9%)
├── Sonnet (892 calls)       $43.70  (91%)

EFFICIENCY METRICS:
├── Estimation accuracy: 88% within 20%
├── Tasks completed under estimate: 62%
├── Largest overrun: +$0.34 (Stripe integration)

TRENDS:
├── Cost per task: DOWN 12% vs December
├── Local LLM usage: UP 40% (more Q&A routed locally)
├── Standing order efficiency: STABLE

RECOMMENDATIONS:
1. Your 'code review' standing order used $3.20 but you 
   only acted on 2 of 15 reports. Consider reducing frequency?
2. 23 simple questions went to Haiku that could use local LLM.
   I'll adjust routing rules.

Projected February cost: $45-55 (based on current patterns)"
```

---

### Cost-Aware Execution

The employee factors cost into its decisions:

```
Scenario: You ask to "clean up the codebase"
─────────────────────────────────────────────

Employee: "I can approach this several ways:

OPTION A: Comprehensive (Recommended)
- Analyze all 847 files
- Fix style issues, dead code, type errors
- Estimated: $1.20 | Time: 3 hours
- Daily budget impact: 24%

OPTION B: Targeted
- Focus on files changed in last 30 days (124 files)
- Same fixes, smaller scope
- Estimated: $0.35 | Time: 45 min
- Daily budget impact: 7%

OPTION C: Minimal
- Only fix errors (not warnings)
- Estimated: $0.12 | Time: 15 min
- Daily budget impact: 2%

Your remaining daily budget: $3.80

Which approach?"
```

```
Scenario: Expensive task near budget limit
─────────────────────────────────────────────

You: "Build the analytics dashboard from this PRD"

Employee: "This PRD will cost approximately $2.40.

Problem: Your remaining daily budget is $1.20.

Options:
A) Start today, pause at budget, continue tomorrow
   - You'll have partial progress tonight
   - Full completion by tomorrow noon

B) Queue for tomorrow (full $5.00 budget available)
   - No progress today
   - Full completion by tomorrow evening

C) Increase today's budget to $3.50
   - Counts against weekly budget
   - Full completion tonight

D) Reduce scope (I'll suggest cuts)
   - Estimated cost after cuts: $0.90
   - Deferred features: real-time updates, export functionality

Which approach?"
```

---

### Spending Transparency

Every task completion includes cost:

```
Employee: "Task complete: Add user avatars to comments

Files changed: 4
Time: 12 minutes
Cost: $0.08 (Sonnet: $0.07, Haiku: $0.01)

Budget status:
├── Today: $2.34 / $5.00 (47%)
├── This week: $12.80 / $25.00 (51%)
└── This month: $34.20 / $75.00 (46%)

PR ready: github.com/you/repo/pull/156"
```

**On-demand cost check:**
```
You: "cost"

Employee: "Current budget status:

TODAY (resets in 8h 23m):
████████░░░░░░░░░░░░ 42%
$2.10 spent / $5.00 limit
$2.90 remaining

THIS WEEK (resets in 3d):
██████████░░░░░░░░░░ 51%
$12.75 spent / $25.00 limit
$12.25 remaining

THIS MONTH (resets in 18d):
████████░░░░░░░░░░░░ 38%
$28.50 spent / $75.00 limit
$46.50 remaining

Queued tasks: 0
Standing orders: 3 active
Projected month-end: $52-58 (under budget)"
```

---

## Human Responsibilities & Handoff Protocol

### Why The Employee Won't Touch Certain Things

| Category | Why Not Automate |
|----------|------------------|
| Account creation | CAPTCHAs, ToS violations, bot detection |
| Credential entry | Security risk, 2FA flows, liability |
| Payment setup | Legal/financial liability |
| Identity verification | Impossible to automate |
| Terms acceptance | Legal requirement for human consent |

The employee's job is to **make your manual steps as fast as possible**, not to pretend they don't exist.

---

### The Dependency Checklist

When the employee hits something that requires you, it generates a **dependency checklist** - exact steps, links, and what to send back.

```
Employee: "To complete this task, I need you to do the following:

DEPENDENCY CHECKLIST (3 items)
─────────────────────────────

[ ] 1. CREATE SUPABASE PROJECT

    Go to: https://supabase.com/dashboard/new
    
    Settings to use:
    - Project name: dive-management-prod
    - Database password: (generate strong, save it)
    - Region: us-east-1 (closest to your users)
    - Plan: Free tier is fine for now
    
    Time estimate: 2 minutes
    
    When done, send me:
    - Project URL (looks like: https://xxxxx.supabase.co)
    - Anon key (from Settings > API)
    - Service role key (from Settings > API)

[ ] 2. CREATE STRIPE ACCOUNT

    Go to: https://dashboard.stripe.com/register
    
    After signup:
    - Enable Test Mode (toggle in sidebar)
    - Go to Developers > API keys
    
    Time estimate: 5 minutes
    
    When done, send me:
    - Publishable key (pk_test_...)
    - Secret key (sk_test_...)

[ ] 3. SET UP DOMAIN DNS

    Go to your domain registrar (Namecheap, Cloudflare, etc.)
    
    Add these DNS records:
    - Type: CNAME
    - Name: app
    - Value: cname.vercel-dns.com
    
    Time estimate: 2 minutes
    
    When done, reply 'dns done' (I'll verify propagation)

─────────────────────────────
TOTAL TIME: ~10 minutes

Reply with credentials as you complete each item, or 
'all done' when finished. I'll continue automatically 
once I have everything.

Status: BLOCKED (waiting for dependencies)"
```

---

### Credential Handling

When you send credentials, the employee:
1. Acknowledges receipt
2. Stores securely (encrypted)
3. Never echoes them back
4. Confirms they work

```
You: "Supabase URL: https://abcd1234.supabase.co
      Anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
      Service key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

Employee: "Supabase credentials received.

[x] URL: Stored (verified: connection successful)
[x] Anon key: Stored (verified: valid format)
[x] Service key: Stored (verified: valid format)

Added to: ~/.signal-controller/.env.encrypted

Remaining dependencies:
[ ] Stripe keys
[ ] DNS setup

Send Stripe keys when ready."
```

---

### Prerequisite Detection

Before starting a PRD, the employee scans for dependencies you might not have:

```
You: "Build me a SaaS app with auth, payments, and email notifications"

Employee: "PRD acknowledged. Scanning for prerequisites...

PREREQUISITES CHECK:
────────────────────

[?] Database: No Supabase/Neon credentials found
    → NEEDED: You'll need to create a database

[?] Payments: No Stripe credentials found
    → NEEDED: You'll need a Stripe account

[?] Email: No Resend/SendGrid credentials found
    → NEEDED: You'll need an email service

[x] Domain: Not required for MVP (can use Vercel subdomain)

[x] Hosting: Vercel (already configured)

RECOMMENDED SETUP ORDER:
1. Supabase (5 min) - needed first for user tables
2. Stripe (5 min) - needed for payment flows  
3. Resend (3 min) - needed for transactional email

Total setup time: ~15 minutes

Options:
A) Send me setup checklist, I'll wait
B) Start building what I can, pause at integrations
C) Skip payments/email for MVP, add later

Which approach?"
```

---

### Progressive Unblocking

The employee doesn't wait for everything. It works on what it can:

```
Employee: "Starting PRD execution with partial dependencies.

WILL BUILD NOW (no dependencies):
├── Database schema design
├── API route structure
├── UI components
├── Navigation and layout
└── Type definitions

WILL PAUSE AT:
├── Auth implementation (needs Supabase)
├── Payment flows (needs Stripe)
└── Email triggers (needs Resend)

Starting now. Send credentials anytime - I'll integrate 
them as they arrive and continue building."
```

Then, when you send credentials mid-build:

```
You: "Supabase URL: https://xyz.supabase.co [keys...]"

Employee: "Supabase credentials received and verified.

UNBLOCKED:
├── Auth implementation → Starting now
├── Database migrations → Queued after auth

Still waiting for:
├── Stripe (payment flows)
├── Resend (email triggers)

Continuing build..."
```

---

### Service Recommendations

When you need a service and haven't specified one, the employee recommends:

```
Employee: "This project needs a database. You haven't specified one.

RECOMMENDATIONS:
────────────────

1. SUPABASE (Recommended for this project)
   - Built-in auth, RLS, realtime
   - Free tier: 500MB, 50k monthly active users
   - Setup time: 3 minutes
   - Best for: Full-stack apps with auth
   
2. NEON
   - Serverless Postgres, scales to zero
   - Free tier: 512MB, unlimited projects
   - Setup time: 2 minutes
   - Best for: Multiple small projects
   
3. PLANETSCALE
   - MySQL-compatible, branching workflow
   - Free tier: 5GB, 1B row reads/month
   - Setup time: 3 minutes
   - Best for: High-read applications

My recommendation: Supabase
Reason: Your PRD mentions user auth and realtime features.
        Supabase handles both natively.

Reply 'supabase', 'neon', 'planetscale', or specify another."
```

---

### The "What Will I Need?" Query

You can ask upfront what a project requires:

```
You: "What will I need to build a job board with payments?"

Employee: "For a job board with payments, you'll need:

REQUIRED (must have before launch):
─────────────────────────────────
[ ] Database
    Recommendation: Supabase
    Setup time: 3 min
    Cost: Free tier sufficient for MVP

[ ] Payment processor  
    Recommendation: Stripe
    Setup time: 5 min
    Cost: 2.9% + $0.30 per transaction

[ ] Auth provider
    Recommendation: Supabase Auth (included with DB)
    Setup time: 0 min (bundled)
    Cost: Free

RECOMMENDED (improves UX):
─────────────────────────
[ ] Email service (for notifications)
    Recommendation: Resend
    Setup time: 3 min
    Cost: Free up to 3k emails/month

[ ] File storage (for company logos, resumes)
    Recommendation: Supabase Storage (included)
    Setup time: 0 min (bundled)
    Cost: Free up to 1GB

OPTIONAL (can add later):
─────────────────────────
[ ] Search (for job listings)
    Recommendation: Algolia or Supabase full-text
    Setup time: 10 min
    Cost: Algolia free up to 10k records

[ ] Analytics
    Recommendation: Vercel Analytics or Plausible
    Setup time: 5 min
    Cost: Free tier available

TOTAL SETUP TIME: ~15 minutes for required items
ESTIMATED PROJECT COST: $0 to launch (free tiers)

Want me to generate the full setup checklist?"
```

---

### Browser Task Templates

For common browser tasks, the employee provides copy-paste templates:

```
Employee: "STRIPE SETUP TEMPLATE

I can't create this account for you (requires human), but 
here's exactly what to do:

1. OPEN: https://dashboard.stripe.com/register

2. FILL FORM:
   Email: [your email]
   Full name: [your name]
   Country: United States
   Password: [generate secure password]

3. VERIFY EMAIL (check inbox)

4. AFTER LOGIN, GO TO:
   https://dashboard.stripe.com/test/apikeys

5. COPY THESE VALUES:
   - Publishable key: pk_test_...
   - Secret key: sk_test_... (click 'Reveal')

6. SEND ME (copy-paste this format):
   STRIPE_PUBLISHABLE_KEY=pk_test_xxx
   STRIPE_SECRET_KEY=sk_test_xxx

Estimated time: 3-5 minutes
I'll wait here. Send keys when ready."
```

---

### Credential Security Contract

```
Employee: "CREDENTIAL HANDLING POLICY

When you send me credentials, here's what happens:

IMMEDIATELY:
- Validated (format check, connection test)
- Encrypted with AES-256
- Stored in ~/.signal-controller/.env.encrypted
- Original message: NOT stored in conversation history

NEVER:
- Echoed back to you
- Logged in plaintext
- Sent to any external service except the intended API
- Stored in git or any version control

ON REQUEST:
- 'show env' → Shows which keys are set (not values)
- 'rotate [key]' → Prompts you for new value, replaces old
- 'delete [key]' → Removes from encrypted storage

Example:
You: 'show env'
Me: 'Configured credentials:
     [x] SUPABASE_URL
     [x] SUPABASE_ANON_KEY  
     [x] SUPABASE_SERVICE_KEY
     [x] STRIPE_SECRET_KEY
     [ ] RESEND_API_KEY (not set)'

Your credentials are yours. I'm a tool, not a custodian."
```

---

### Summary: Division of Labor

| Task | Employee | You |
|------|----------|-----|
| Write code | Yes | Review |
| Run commands | Yes | N/A |
| Create accounts | No | Yes (with checklist) |
| Enter credentials | No | Yes (secure handoff) |
| Accept ToS | No | Yes |
| Make payments | No | Yes (with recommendations) |
| Design decisions | Proposes | Approves |
| Architecture | Proposes | Approves |
| Deploy to prod | Prepares | Final approval |
| Monitor systems | Yes | Escalations only |
| Answer questions | Yes | N/A |
| Learn preferences | Yes | Correct when wrong |

**The employee maximizes your leverage, not your absence.** Some things require a human. The employee's job is to make those moments as rare and as fast as possible.

---

## Interface Options (Security Analysis)

Signal is the primary interface, but not the only option. Each has different security tradeoffs.

### Interface Comparison Matrix

| Interface | E2E Encrypted | Self-Hosted | Auth Method | Data Residency | Attack Surface | Verdict |
|-----------|---------------|-------------|-------------|----------------|----------------|---------|
| **Signal** | Yes | No (but federated) | Phone number | Signal servers | Low | **Primary** |
| **Matrix** | Yes | Yes | Username/password | Your server | Medium | **Secondary** |
| **SSH + CLI** | Yes | Yes | Key-based | Your server | Very Low | **Power user** |
| **Local Web UI** | N/A (localhost) | Yes | None needed | Local only | Very Low | **Home use** |
| **Telegram** | Optional | No | Phone number | Telegram servers | Medium | Not recommended |
| **Slack/Discord** | No | No | OAuth | Corporate servers | High | **Never** |
| **Email (PGP)** | Yes (if PGP) | Depends | Email address | Email provider | Medium | Async only |
| **iMessage** | Yes | No | Apple ID | Apple servers | Low | Apple ecosystem only |

---

### Primary: Signal

**Why Signal is the default:**
- End-to-end encrypted by default (no opt-in required)
- Open source protocol, audited
- Phone number auth is "something you have" factor
- Works anywhere you have cell/wifi
- No corporate data harvesting
- Minimal metadata retention

**Security configuration:**
```javascript
{
  "interfaces": {
    "signal": {
      "enabled": true,
      "allowedNumbers": ["+1234567890"],  // Strict allowlist
      "rejectUnknown": true,              // Silent reject, no response
      "rateLimitUnknown": true,           // Throttle unknown senders
      "logUnknownAttempts": true,         // Audit trail
      "disappearingMessages": false,      // Keep audit trail
      "verifyIdentityKey": true           // Alert on key change
    }
  }
}
```

**Signal-specific threats:**
| Threat | Mitigation |
|--------|------------|
| SIM swap attack | Use eSIM, enable Signal PIN, verify identity key changes |
| Phone theft | Signal app lock (biometric/PIN) |
| Number reuse | Verify identity key on first contact |
| Metadata analysis | Minimal - Signal retains almost nothing |

---

### Secondary: Matrix (Self-Hosted)

For maximum control, run your own Matrix server.

**Why Matrix:**
- Fully self-hosted option (Synapse server)
- E2E encrypted (Olm/Megolm protocol)
- No phone number required
- Federation optional (can run isolated)
- Open protocol, multiple clients

**When to use Matrix:**
- You don't trust any third party
- You want multiple devices without phone dependency
- You want to share access with trusted collaborators
- Compliance requires data residency

**Architecture:**
```
┌─────────────────────────────────────────┐
│              YOUR HOMELAB                │
│                                          │
│  ┌──────────────┐    ┌───────────────┐  │
│  │ Matrix       │    │  Employee     │  │
│  │ Synapse      │◄──►│  Bridge       │  │
│  │ Server       │    │               │  │
│  └──────────────┘    └───────────────┘  │
│         ▲                               │
│         │ E2E Encrypted                 │
│         ▼                               │
│  ┌──────────────┐                       │
│  │ Element      │ (on your phone)       │
│  │ Client       │                       │
│  └──────────────┘                       │
│                                          │
└─────────────────────────────────────────┘
```

**Configuration:**
```javascript
{
  "interfaces": {
    "matrix": {
      "enabled": true,
      "homeserver": "https://matrix.yourdomain.com",
      "userId": "@employee:yourdomain.com",
      "accessToken": "${MATRIX_ACCESS_TOKEN}",
      "allowedUsers": ["@you:yourdomain.com"],
      "allowedRooms": ["!roomid:yourdomain.com"],
      "verifyDevices": true,
      "rejectUnverified": true
    }
  }
}
```

---

### Power User: SSH + CLI

The most secure option. No third parties at all.

**Why SSH:**
- No third-party servers
- Key-based authentication (strongest)
- Encrypted tunnel
- Full audit via shell history
- Works over any network

**When to use:**
- You're at a computer anyway
- Maximum security required
- Scripting/automation use cases
- Low latency needs

**Architecture:**
```
┌─────────────┐    SSH Tunnel    ┌─────────────────┐
│ Your laptop │◄────────────────►│ Homelab         │
│ or phone    │                  │                 │
│ (Termux)    │   Key-based auth │ employee-cli    │
└─────────────┘                  └─────────────────┘
```

**CLI interface:**
```bash
# Direct command
$ ssh homelab "employee open basecamp"
Opened basecamp project.

# Interactive session
$ ssh homelab employee-shell
employee> status
All systems operational. 3 standing orders active.
employee> what did I work on yesterday?
Yesterday you committed 12 times to dive-management...
employee> exit

# Pipe a PRD
$ cat feature.md | ssh homelab "employee prd"
PRD received. Estimated cost: $0.45. Starting...
```

**Configuration:**
```javascript
{
  "interfaces": {
    "cli": {
      "enabled": true,
      "socketPath": "/tmp/employee.sock",  // Unix socket
      "requireAuth": false,  // SSH already authenticated
      "allowedUsers": ["your-username"],
      "historyFile": "~/.employee_history",
      "maxHistorySize": 1000
    }
  }
}
```

---

### Home Use: Local Web UI

When you're on the same network, a local web UI can be convenient.

**Security model:**
- Binds to localhost or LAN IP only
- Never exposed to internet
- Optional: require local network authentication
- Optional: mTLS for LAN access

**Configuration:**
```javascript
{
  "interfaces": {
    "webui": {
      "enabled": true,
      "host": "127.0.0.1",    // Localhost only by default
      // "host": "192.168.1.50", // LAN access (more risk)
      "port": 3847,
      "authentication": {
        "required": true,      // Even on localhost
        "method": "password",  // or "none" for localhost-only
        "sessionTimeout": "1h"
      },
      "https": {
        "enabled": true,       // Self-signed cert for LAN
        "certPath": "~/.signal-controller/certs/"
      },
      "cors": {
        "enabled": false       // No cross-origin requests
      }
    }
  }
}
```

**What the Web UI provides:**
- Real-time task progress
- Cost dashboard
- Log viewer
- Preference editor
- Standing order management
- Trust level display

**What it does NOT provide:**
- Remote access (use Signal/Matrix/SSH for that)
- Public internet exposure
- API endpoints for external services

---

### Never Use: Slack, Discord, Teams

**Why not:**
- No E2E encryption (they can read everything)
- Corporate data retention policies
- OAuth token exposure risk
- Audit logs accessible to workspace admins
- API rate limits not in your control
- Account termination risk

If your employer uses Slack, your employee should not.

---

### Multi-Interface Configuration

You can enable multiple interfaces with unified authentication:

```javascript
{
  "interfaces": {
    "signal": {
      "enabled": true,
      "priority": 1  // Primary
    },
    "matrix": {
      "enabled": true,
      "priority": 2  // Fallback
    },
    "cli": {
      "enabled": true,
      "priority": 3  // When at computer
    },
    "webui": {
      "enabled": true,
      "priority": 4  // Dashboard only
    }
  },
  "unifiedAuth": {
    "trustAcrossInterfaces": true,  // Same trust level everywhere
    "auditAcrossInterfaces": true,  // Unified log
    "preferenceSync": true           // Same preferences everywhere
  }
}
```

**Interface failover:**
```
Employee: "Signal interface unreachable (network issue).

Failover options:
1. Matrix: Available (last seen: 2 min ago)
2. SSH: Available (if you have terminal access)
3. Web UI: Available (if on local network)

Switching primary to Matrix until Signal recovers.
Reply on any interface to confirm you can reach me."
```

---

## Cursor Independence Roadmap

Cursor is the initial execution layer. It's not the end state.

> **ToS Compliance Note**
> 
> Moving beyond Cursor does not violate their Terms of Service. Cursor's ToS 
> Section 1.5(v) prohibits using Cursor's output to "develop or train a model 
> that is competitive with the Service." This project:
> 
> - Does NOT train any AI model
> - Does NOT extract Cursor's model weights
> - Does NOT build a competing IDE
> - Simply uses Claude API (Anthropic's model) directly
> 
> Choosing not to use a product is not a ToS violation. You're graduating 
> from their tool, not stealing their technology.

### Why Start with Cursor

| Reason | Explanation |
|--------|-------------|
| Proven tooling | Cursor's AI coding is battle-tested |
| Lower risk | IDE has undo, git integration, safeguards |
| Familiar | You already know how to review Cursor's work |
| Fast start | No need to build code generation from scratch |

### Why Move Beyond Cursor

| Reason | Explanation |
|--------|-------------|
| Overhead | GUI is unnecessary for autonomous work |
| Dependency | Cursor's pricing, ToS, availability out of your control |
| Speed | Direct file operations are faster than IDE automation |
| Control | Full control over the entire stack |
| Self-improvement | Employee can't easily modify itself through Cursor |

### The Transition Path

```
PHASE 1: Cursor-Dependent (Now)
──────────────────────────────
Employee → Cursor CLI → Code Generation → Files

- Employee sends instructions to Cursor
- Cursor does the AI code generation
- Files modified through Cursor
- Git operations through Cursor

Trust level required: 1-2
Risk: Low (Cursor has safeguards)


PHASE 2: Cursor-Optional (3-6 months)
─────────────────────────────────────
Employee → Claude API → Direct File Operations

- Employee calls Claude API directly
- Same models Cursor uses, no middleman
- File operations via Node.js fs
- Git operations via git CLI

Trust level required: 3+
Risk: Medium (fewer safeguards, more power)

Prerequisites:
[x] Employee has demonstrated reliable code generation
[x] Rollback mechanisms tested and working
[x] Sandbox testing environment established
[x] You're comfortable reviewing PRs without IDE


PHASE 3: Self-Modifying (6-12 months)
─────────────────────────────────────
Employee → Modifies Own Codebase → Better Employee

- Employee can improve its own capabilities
- Proposes changes, tests in sandbox, requests approval
- Version-controlled self-modification
- Constrained by immutable safety boundaries

Trust level required: 4+
Risk: Medium-High (requires robust safety rails)

Prerequisites:
[x] Phase 2 stable for 3+ months
[x] Self-modification sandbox tested
[x] Rollback tested with actual self-modifications
[x] Clear boundaries on what it cannot change
```

### Phase 2 Architecture: Direct Coding

```javascript
// Instead of: cursor --project ~/foo (then send instructions)
// Direct approach:

const { Anthropic } = require('@anthropic-ai/sdk');
const fs = require('fs/promises');
const { execSync } = require('child_process');

class DirectCoder {
  constructor(config) {
    this.claude = new Anthropic({ apiKey: config.apiKey });
    this.workingDir = config.workingDir;
  }

  async implementFeature(specification) {
    // 1. Read relevant files
    const context = await this.gatherContext(specification);
    
    // 2. Generate code via Claude API
    const response = await this.claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: this.systemPrompt,
      messages: [{
        role: 'user',
        content: `Context:\n${context}\n\nSpecification:\n${specification}`
      }]
    });
    
    // 3. Parse response into file operations
    const operations = this.parseOperations(response.content);
    
    // 4. Apply changes (with backup)
    await this.applyWithBackup(operations);
    
    // 5. Run tests
    const testResult = await this.runTests();
    
    // 6. Commit if tests pass
    if (testResult.passed) {
      await this.commit(specification);
    } else {
      await this.rollback();
    }
    
    return { success: testResult.passed, operations, testResult };
  }

  async applyWithBackup(operations) {
    // Create backup branch before any changes
    execSync('git checkout -b backup-' + Date.now(), { cwd: this.workingDir });
    execSync('git checkout -', { cwd: this.workingDir });
    
    for (const op of operations) {
      if (op.type === 'create') {
        await fs.writeFile(op.path, op.content);
      } else if (op.type === 'modify') {
        await fs.writeFile(op.path, op.content);
      } else if (op.type === 'delete') {
        await fs.unlink(op.path);
      }
    }
  }

  async rollback() {
    // Find most recent backup branch and restore
    execSync('git checkout . && git clean -fd', { cwd: this.workingDir });
  }
}
```

### Phase 3 Architecture: Self-Modification

```javascript
{
  "selfModification": {
    "enabled": true,
    
    // What it CAN modify
    "allowed": [
      "src/capabilities/*",     // Add new capabilities
      "src/prompts/*",          // Improve its own prompts
      "src/utils/*",            // Utility functions
      "config.json"             // Non-security config
    ],
    
    // What it CANNOT modify (enforced at filesystem level)
    "forbidden": [
      "src/safety/*",           // Safety rails
      "src/auth/*",             // Authentication
      "src/trust/*",            // Trust system
      "src/selfmod/forbidden.js", // This very list
      ".env*",                  // Credentials
      "budget.json"             // Spending limits
    ],
    
    // Process for allowed modifications
    "process": {
      "proposalRequired": true,
      "sandboxTest": true,
      "approvalRequired": true,  // Until trust level 5
      "rollbackOnFailure": true,
      "maxChangesPerDay": 5
    }
  }
}
```

**Immutable safety layer:**
```javascript
// src/selfmod/forbidden.js
// This file is read-only at the filesystem level (chattr +i on Linux)
// Employee cannot modify it even if it tries

const FORBIDDEN_PATHS = [
  /src\/safety\//,
  /src\/auth\//,
  /src\/trust\//,
  /\.env/,
  /budget\.json/,
  /selfmod\/forbidden\.js/
];

function canModify(filepath) {
  for (const pattern of FORBIDDEN_PATHS) {
    if (pattern.test(filepath)) {
      console.log(`[BLOCKED] Attempt to modify forbidden path: ${filepath}`);
      return false;
    }
  }
  return true;
}

// This function is called by the kernel-level file watcher
// Not by the employee's code
module.exports = { canModify, FORBIDDEN_PATHS };
```

### Safety Boundaries That Never Change

No matter how high the trust level:

| Boundary | Enforcement |
|----------|-------------|
| Cannot modify safety rails | Filesystem immutable flag |
| Cannot modify trust system | Filesystem immutable flag |
| Cannot increase own trust | Logic in immutable code |
| Cannot exceed budget | Enforced at API call level |
| Cannot disable audit logging | Separate process, different user |
| Cannot access other users' data | Unix permissions |
| Cannot expose credentials | Encrypted storage, no decrypt capability |

**Defense in depth:**
```
Layer 1: Code-level checks (can be bypassed if code modified)
Layer 2: Filesystem permissions (requires root to bypass)
Layer 3: Separate audit process (different user, can't be killed)
Layer 4: Network isolation (no outbound except allowlist)
Layer 5: Your review (final approval on significant changes)
```

### Graduation Criteria

**Phase 1 → Phase 2:**
- [ ] 50+ successful tasks via Cursor
- [ ] 0 critical failures in last 30 days
- [ ] Rollback mechanism tested 5+ times
- [ ] You've reviewed and approved transition plan
- [ ] Test environment mirrors production

**Phase 2 → Phase 3:**
- [ ] 100+ successful tasks via direct coding
- [ ] 0 critical failures in last 60 days
- [ ] Self-modification sandbox tested with 10+ changes
- [ ] Immutable safety boundaries verified
- [ ] Audit system verified independent
- [ ] You've explicitly enabled self-modification

### What Self-Modification Looks Like

```
Employee: "Self-improvement proposal:

OBSERVATION:
I've noticed that 40% of my PRD parsing errors come from 
ambiguous section headers. I misinterpret 'Requirements' 
as functional requirements when it sometimes means 
technical requirements.

PROPOSED CHANGE:
Add a clarifying question to my PRD intake flow when 
'Requirements' section is ambiguous.

FILE: src/capabilities/prd-parser.js
CHANGE TYPE: Add function
LINES: +23

DIFF:
+ async function clarifyRequirementsSection(prdContent) {
+   const requirementsSection = extractSection(prdContent, 'Requirements');
+   if (requirementsSection && !hasSubheadings(requirementsSection)) {
+     return {
+       needsClarification: true,
+       question: 'Your PRD has a Requirements section without subsections. ' +
+                 'Does this contain functional requirements (what it should do) ' +
+                 'or technical requirements (how it should be built)?'
+     };
+   }
+   return { needsClarification: false };
+ }

TESTING:
- Ran against 50 historical PRDs
- Would have correctly identified ambiguity in 12 cases
- No false positives

RISK ASSESSMENT: Low
- Read-only analysis, no side effects
- Adds a question, doesn't change behavior
- Easy to revert

Approve modification? [Yes / No / Modify]"
```

---

### The End State

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR EMPLOYEE                            │
│                                                                  │
│   Interfaces:     [Signal] [Matrix] [SSH] [Web UI]              │
│                              │                                   │
│                              ▼                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Core Intelligence                     │   │
│   │                                                          │   │
│   │   - Understands your preferences                        │   │
│   │   - Plans and executes autonomously                     │   │
│   │   - Improves itself over time                           │   │
│   │   - Manages budget and resources                        │   │
│   │   - Coordinates standing orders                         │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│   ┌──────────┐        ┌──────────┐        ┌──────────┐         │
│   │  Haiku   │        │  Sonnet  │        │  Direct  │         │
│   │  (Cheap) │        │  (Smart) │        │  Coding  │         │
│   └──────────┘        └──────────┘        └──────────┘         │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                 Safety Boundaries                        │   │
│   │                 (Immutable Layer)                        │   │
│   │                                                          │   │
│   │   - Cannot modify safety code                           │   │
│   │   - Cannot modify trust system                          │   │
│   │   - Cannot exceed budget                                │   │
│   │   - Cannot disable auditing                             │   │
│   │   - Cannot expose credentials                           │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

No Cursor. No dependencies you don't control. An employee that gets better over time, constrained by boundaries that cannot be changed no matter how smart it gets.

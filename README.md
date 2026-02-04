# Signal Cursor Controller

Your personal AI coding assistant. Control projects, analyze codebases, and make code changes through natural language.

## Features

- **Natural Language Commands**: "work on dive connect", "open sentinel", "what's the project status"
- **AI-Powered Analysis**: Ask questions about your codebase, get status reports, understand architecture
- **Code Editing**: Ask for changes, review diffs, apply or reject with one click
- **Project Auto-Discovery**: Scans directories for projects with fuzzy name matching
- **Sci-Fi Command Center UI**: Beautiful dark-themed dashboard with real-time updates
- **Secure by Design**: Localhost only, command whitelist, no shell injection

## Quick Start

### 1. Install Dependencies

```bash
cd signal-cursor-controller
npm install
```

### 2. Configure

```bash
# Create config files from examples
cp config.example.json config.json
cp .env.example .env
```

**Edit `.env`:**
```env
ANTHROPIC_API_KEY=your-api-key-here
```

**Edit `config.json`:**
```json
{
  "projects": {
    "directories": ["C:\\Users\\you\\projects"]
  },
  "commands": {
    "cursor": "C:\\Users\\you\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd"
  },
  "claude": {
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 2000
  }
}
```

### 3. Run

```bash
npm run dev
```

Open http://127.0.0.1:3847 in your browser.

## Usage

### Natural Language Commands

You can speak naturally - the AI understands context and intent.

**Project Management:**
```
open dive connect ai     → Opens project (fuzzy matching)
work on sentinel         → Same as open
switch to legends agile  → Same as open
list projects           → Show all discovered projects
```

**AI Analysis:**
```
analyze sentinel                          → Load project context for AI
what is the status of this project        → Get project overview
how does authentication work              → Ask about architecture
where are the API endpoints               → Find code locations
explain the database schema               → Understand structure
```

**Code Changes:**
```
fix the typo in readme                    → AI suggests edit
add error handling to the scan function   → AI proposes changes
refactor this to use async/await          → AI generates diff
```

**Reviewing Changes:**
```
show diff    → View pending changes
apply        → Apply all changes
reject       → Discard changes
```

**System:**
```
status       → Check system status
help         → Show command reference
```

### The UI

The command center has three main areas:

1. **Command Console** (left): Chat interface for commands and AI responses
2. **Pending Changes** (left, below): Real-time diff viewer with Apply/Reject buttons
3. **Right Panel**: System status, quick commands, project list, AI session info

## How Code Editing Works

1. Start an AI session: `analyze my-project`
2. Ask for a change: `add logging to the main function`
3. Claude analyzes the code and suggests changes
4. Changes appear in the **Pending Changes** panel with diffs
5. Review the red (removed) and green (added) lines
6. Click **APPLY ALL** to write changes or **REJECT** to discard

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                  Command Center UI (localhost:3847)            │
│  ┌──────────────────────┐  ┌────────────────────────────────┐  │
│  │   Command Console    │  │       Right Panel              │  │
│  │   • Natural input    │  │  • System status               │  │
│  │   • AI responses     │  │  • Agent status                │  │
│  │   • Markdown render  │  │  • Project list                │  │
│  ├──────────────────────┤  │  • Quick commands              │  │
│  │   Pending Changes    │  │                                │  │
│  │   • Diff viewer      │  │                                │  │
│  │   • Apply/Reject     │  │                                │  │
│  └──────────────────────┘  └────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                         Backend                                 │
│  ┌───────────┐   ┌───────────┐   ┌───────────┐                │
│  │  Intent   │──▶│    AI     │──▶│  Command  │                │
│  │  Parser   │   │  Agent    │   │ Executor  │                │
│  └───────────┘   └───────────┘   └───────────┘                │
│       │               │               │                        │
│       ▼               ▼               ▼                        │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    │
│  │ Claude  │    │ Project │    │  File   │    │ Cursor  │    │
│  │   API   │    │ Scanner │    │ Editor  │    │   CLI   │    │
│  └─────────┘    └─────────┘    └─────────┘    └─────────┘    │
└────────────────────────────────────────────────────────────────┘
```

## Security

- **Localhost Only**: Web UI binds to 127.0.0.1, never exposed to network
- **Command Whitelist**: Only `cursor` executable allowed for external commands
- **No Shell Injection**: Uses `spawn()` not `exec()` - arguments are never parsed by shell
- **Path Validation**: All file paths validated against project directories
- **Rate Limiting**: Configurable request limits (messages per minute/hour/day)

## Configuration Reference

### config.json

| Setting | Description |
|---------|-------------|
| `projects.directories` | Array of paths to scan for projects |
| `projects.scan_depth` | How deep to scan (default: 2) |
| `projects.markers` | Files that indicate a project root |
| `commands.cursor` | Path to Cursor CLI executable |
| `claude.model` | Claude model ID (e.g., `claude-sonnet-4-20250514`) |
| `claude.max_tokens` | Maximum response tokens |
| `server.host` | Server bind address (use `127.0.0.1`) |
| `server.port` | Server port (default: 3847) |
| `security.allowed_numbers` | Phone numbers for Signal auth (Phase 2) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `NODE_ENV` | Set to `production` for production mode |

## Development

```bash
# Development with hot reload
npm run dev

# Type check
npm run build

# Start production build
npm start
```

## Phase Roadmap

- [x] **Phase 1**: Foundation - Web UI, project scanner, basic commands
- [x] **Phase 1.5**: AI Assistant - Claude-powered analysis and code editing
- [ ] **Phase 2**: Signal Integration - Real signal-cli on Linux
- [ ] **Phase 3**: Terminal Commands - npm, git with whitelist
- [ ] **Phase 4**: Context + Memory - Remember preferences
- [ ] **Phase 5**: PRD Execution - Autonomous building
- [ ] **Phase 6+**: Trust escalation, budget management, and more

## Requirements

- Node.js 18+
- Cursor IDE installed
- Anthropic API key

## Troubleshooting

**"Project not found"**: Try `list projects` to see available names. Project matching is fuzzy - "dive connect" matches "diveconnect-ai".

**"No active AI session"**: Run `analyze <project>` first to load project context before asking questions.

**Changes not applying**: Make sure Claude formatted the edit blocks correctly. Check the console for error messages.

## License

MIT

# Signal Cursor Controller

Control Cursor IDE from your phone via Signal messages. Your personal AI employee.

## Features (Phase 1)

- **Natural Language Commands**: "open basecamp", "go to line 50", "list projects"
- **Project Auto-Discovery**: Scans directories for projects automatically
- **Sci-Fi Command Center UI**: Beautiful web dashboard for testing and monitoring
- **Secure by Design**: Phone number allowlist, command whitelist, no shell injection

## Quick Start

### 1. Install Dependencies

```bash
cd signal-cursor-controller
npm install
```

### 2. Configure

```bash
# Copy example configs
cp config.example.json config.json
cp .env.example .env

# Edit .env with your Anthropic API key
# Edit config.json with your project directories
```

**config.json settings:**
- `projects.directories`: Array of paths to scan for projects
- `security.allowed_numbers`: Phone numbers that can send commands
- `commands.cursor`: Path to your Cursor CLI executable
- `claude.model`: Model to use (e.g., `anthropic/claude-sonnet-4.5`)

**Windows Cursor CLI path:**
```
C:\Users\<username>\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd
```

### 3. Run

```bash
npm run dev
```

Open http://127.0.0.1:3847 in your browser.

## Commands

| Command | Description |
|---------|-------------|
| `open <project>` | Open a project in Cursor |
| `open <file> in <project>` | Open a specific file |
| `go to line <n>` | Navigate to a line |
| `list projects` | Show all discovered projects |
| `status` | Check system status |
| `help` | Show available commands |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web UI (localhost:3847)               │
│                         │                                │
│                         ▼                                │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│   │ Message  │───▶│  Intent  │───▶│ Command  │         │
│   │ Handler  │    │  Parser  │    │ Executor │         │
│   └──────────┘    └────┬─────┘    └────┬─────┘         │
│        │               │               │                │
│        │               ▼               ▼                │
│        │         ┌──────────┐    ┌──────────┐          │
│        │         │  Claude  │    │  Cursor  │          │
│        │         │   API    │    │   CLI    │          │
│        │         └──────────┘    └──────────┘          │
│        │                                                │
│        ▼                                                │
│   ┌──────────────────────────────────────────────────┐ │
│   │              Project Scanner                      │ │
│   │  Scans directories for .git, package.json, etc.  │ │
│   └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Security

- **Localhost Only**: Web UI binds to 127.0.0.1, never exposed to network
- **Allowlist Auth**: Only configured phone numbers can send commands
- **Command Whitelist**: Only `cursor` executable allowed
- **No Shell**: Uses `spawn()` not `exec()` - no shell injection possible
- **Path Validation**: All paths validated against project whitelist

## Phase Roadmap

- [x] **Phase 1**: Foundation - Web UI, project scanner, basic commands
- [ ] **Phase 2**: Signal Integration - Real signal-cli on Linux
- [ ] **Phase 3**: Terminal Commands - npm, git with whitelist
- [ ] **Phase 4**: Context + Memory - Remember preferences
- [ ] **Phase 5**: PRD Execution - Autonomous building
- [ ] **Phase 6+**: Trust escalation, budget management, and more

## Development

```bash
# Development with hot reload
npm run dev

# Build for production
npm run build

# Start production build
npm start
```

## Requirements

- Node.js 18+
- Cursor IDE installed
- Anthropic API key (for local development)

Note: Uses Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) for cleaner integration. When deployed to Vercel, the AI Gateway handles keys automatically.

## License

MIT

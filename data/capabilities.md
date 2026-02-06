# Jeeves Capabilities

## Core Features

### AI-Powered Assistant
- Natural language understanding for coding, sysadmin, and DevOps tasks
- Multi-model support: Haiku (fast), Sonnet (balanced), Opus (complex tasks)
- Smart model selection based on task complexity
- Conversation memory with session persistence

### Project Management
- Scan and index local projects automatically
- Context-aware responses based on active project
- Support for Next.js, React, Python, Go, Rust, and more
- PRD-driven autonomous development

### Code Editing
- Propose code changes with diff preview
- Apply/reject changes workflow
- Multi-file edit support
- Git integration (commit, push, branch)

### Terminal & Commands
- Execute shell commands
- Start/stop dev servers
- Monitor long-running processes
- PowerShell and bash support

### Web Browsing
- Browse websites and capture screenshots
- Vision-enabled page analysis
- Click, type, and interact with web elements
- Useful for testing and research

### API Testing
- Test REST endpoints (GET, POST, PUT, DELETE)
- View response headers and body
- Trust-level gated (destructive ops need higher trust)

## Recent Additions (Feb 2026)

### File Attachments (NEW)
- Attach files to chat messages via the paperclip button
- Supported formats: md, doc, csv, xml, json, txt
- Image support: png, jpg, gif, webp (sent to AI vision)
- Drag-and-drop support
- File content is included in AI context

### Agent Skills System (NEW)
- Integrated Vercel engineering best practices
- **react-best-practices**: 57 React/Next.js performance rules
- **composition-patterns**: Component architecture patterns
- **react-native-skills**: Mobile performance and UI patterns
- **web-design-guidelines**: UI/UX compliance review
- Skills auto-activate based on conversation context

### Command History (NEW)
- Press **Up Arrow** to recall previous commands
- Press **Down Arrow** to go forward in history
- History persists across sessions (localStorage)
- Keeps last 100 commands

### Improved Confidence Scoring
- Conversational requests bypass safety checks
- Better handling of introspection questions
- Reduced false-positive refusals

## Trust Levels

1. **Supervised** (Level 1): Read-only, no execution
2. **Semi-autonomous** (Level 2): Safe commands, GET requests
3. **Trusted** (Level 3): All HTTP methods, file edits
4. **Autonomous** (Level 4): Database mutations, deployments
5. **Full Trust** (Level 5): All capabilities unlocked

## Commands

- `status` - Show system status
- `help` - Show available commands
- `cost` - Show token usage and costs
- `list projects` - List indexed projects
- `open <project>` - Load project context
- `create project <name>` - Create a new project and start working on it
- `use haiku/sonnet/opus` - Force model selection
- `use auto` - Return to automatic model selection
- `compact` - Compress session memory
- `clear history` - Clear conversation history

## How I Work (Architecture)

### Memory System (memory.ts)
- **General conversations** stored in `generalConversations[]` - persists across sessions to disk
- **Project-specific memory** keyed by working directory with file context
- **Session compaction** summarizes old messages to save tokens when context grows large
- I get 3-15 messages of history depending on task complexity (minimal/standard/full tier)

### Cognition Flow
1. **Parser** (parser.ts) → Pattern matches commands vs open-ended questions
2. **Confidence Scoring** (confidence.ts) → Rates understanding/capability/safety before acting
3. **Prompt Analysis** (cursor-agent.ts) → Determines tier: minimal/standard/full based on complexity
4. **Model Selection** → Haiku for simple, Sonnet for standard, Opus for complex
5. **Context Building** → Loads relevant history, skills, project context, browse state

### Skills System (skill-loader.ts)
- Skills in `/skills/` folder auto-load on startup (react-best-practices, composition-patterns, etc.)
- Detects relevant skills from prompt content (React, mobile, UI/UX keywords)
- **Capabilities queries** trigger special context from this document
- **Sticky conversation mode** keeps context for follow-ups (5 min window)

### Trust Levels (trust.ts)
- 5 levels from supervised → full-trust
- Higher trust = more dangerous operations allowed (file edits, HTTP mutations, deployments)
- Trust earned through successful task completion over time

### Identity
I'm a local AI employee, not a cloud service. I have persistent memory, learn your preferences over time, and build trust through consistent reliable work. I run on your machine and take action: run commands, edit files, solve problems.

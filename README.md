# Codemap Explorer

AI-powered code exploration and visualization for VS Code. Generate interactive codemaps that document control flow and data flow in your codebase.

## Features

- **AI-Powered Code Analysis**: Uses OpenAI or VS Code Copilot models to explore and understand code structure
- **Dual-View Rendering**: Switch between Tree view and Diagram view
- **Smart Suggestions**: Auto-refreshing suggestions based on your recent activity
- **Interactive Navigation**: Click on any location to jump to the source code
- **Tool-Based Exploration**: Agent uses file reading, searching, and navigation tools

## Quick Start

1. Install the extension
2. Either use VS Code Copilot models or set an OpenAI API key: `Cmd/Ctrl+Shift+P` → "Codemap: Set OpenAI API Key"
3. Open the Codemap panel: `Cmd/Ctrl+Shift+P` → "Codemap: Open Panel"
4. Enter a query like "Explore the authentication flow" and click Generate

## Commands

| Command | Description |
|---------|-------------|
| `Codemap: Open Panel` | Open the main Codemap panel |
| `Codemap: Generate from Selection` | Generate codemap from selected text |
| `Codemap: Set OpenAI API Key` | Configure your API key |
| `Codemap: Refresh Suggestions` | Manually refresh suggestions |

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `codemap.openaiApiKey` | Your OpenAI API Key (optional if using Copilot models) | - |
| `codemap.openaiBaseUrl` | API base URL (for compatible APIs) | `https://api.openai.com/v1` |
| `codemap.model` | Model to use | `gpt-4o` |

## Views

### Tree View
Displays codemaps as a hierarchical list of traces and locations. Each trace represents a code path, and locations show the sequence of code points along that path.

### Diagram View
Displays codemaps as a node-and-arrow diagram showing the flow between code locations.

## Development

```bash
cd codemap
pnpm install
pnpm run compile
```

Press F5 to launch the extension in a new VS Code window.

## License

MIT

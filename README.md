# MCP Playground Server

This is a Model Context Protocol (MCP) server that provides intelligent command completion and validation

```
mcp-playground-server/
├── src/
│   ├── index.ts          # Main MCP server implementation
│   ├── parser.ts         # Bashly YAML parser for command structure
│   └── suggester.ts      # Command suggestion logicand assistance for the Kafka Docker Playground CLI. It integrates with GitHub Copilot to offer contextual help, command suggestions, and debugging assistance for playground commands.
```

## Features

- **Command Completion**: Auto-complete playground commands with context-aware suggestions
- **Command Help**: Get detailed help for any playground command or subcommand  
- **Command Validation**: Validate playground commands before execution

## Installation

See FIXTHIS

## Usage

Once configured, the MCP server will be available through GitHub Copilot. You can ask natural language questions about playground commands:

### Example Queries

- "What playground commands are available for managing connectors?"
- "How do I debug connection issues with a connector?"
- "Show me playground commands for container management"
- "What debug options are available for Java class loading?"
- "How do I restart a specific connector?"

### Direct MCP Tools

The server exposes several tools that GitHub Copilot can use automatically:

- `playground_command_help`: Get detailed help for any command
- `playground_command_suggest`: Get command suggestions and completions  
- `playground_command_validate`: Validate command syntax

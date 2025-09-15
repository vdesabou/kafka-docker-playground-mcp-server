#!/bin/sh
set -e

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Set default environment variables if not provided
export NODE_ENV="${NODE_ENV:-production}"
export MCP_SERVER_NAME="${MCP_SERVER_NAME:-mcp-playground-server}"
export MCP_SERVER_VERSION="${MCP_SERVER_VERSION:-1.0.0}"

log "Starting MCP Playground Server..."
log "Environment: $NODE_ENV"
log "Server Name: $MCP_SERVER_NAME"
log "Server Version: $MCP_SERVER_VERSION"

# Execute the command passed to the container
exec "$@"

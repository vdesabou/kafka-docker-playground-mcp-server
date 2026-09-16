# kafka-docker-playground MCP server

An MCP server that exposes the **live state** of a local
[kafka-docker-playground](https://github.com/vdesabou/kafka-docker-playground)
to an AI coding agent: what is running, which connectors are broken and why,
what the container logs actually say, and which of the ~2500 example scripts
matches what you are trying to reproduce.

It deliberately does *not* re-serve the `playground` CLI's command syntax. An
agent working in the repo already has `scripts/cli/playground.json`,
`scripts/cli/src/bashly.yml` and `playground --help`; a second, lossy copy of
that is worse than none. Everything here needs a running Docker daemon, a
Connect REST endpoint or a filesystem scan — things a static reference cannot
provide.

## Tools

| Tool | What it answers |
| --- | --- |
| `playground_status` | Is Docker up? Which example was last run, in which environment, with which connector type? Which containers are up, healthy, or dead, on which ports? What were the last `playground run` commands? |
| `playground_connectors` | What is every connector's state, and for FAILED tasks, what is the **root cause** (deepest `Caused by:`) rather than a 200-frame trace? Works against the running Connect worker *or* the Confluent Cloud Connect API, picked automatically. |
| `playground_logs` | What went wrong in a container, without pulling 10 000 lines into context? De-duplicates repeated errors with occurrence counts and collapses stack traces to the exception chain. Also does raw `tail` and regex `search`. |
| `playground_find_example` | Which example script demonstrates *this*? Searches connector class, script path, README title and script body across `connect/`, `ccloud/`, `ksqldb/`, `flink/`, `reproduction-models/` and the rest. Returns the exact `playground run -f …` command. |
| `playground_example_details` | Everything about one example in one call: script source, the connector payloads it posts, default environment, compose override files, sibling variants, credential handlers, and the environment variables you must export. |

### Why these are worth a tool call

On a real 918 KB / 10 645-line `connect.log`, `playground_logs` returns **4.5 KB**
containing the full `Caused by:` chain — a ~200× reduction with the diagnostic
content intact. `playground_find_example` indexes 2558 scripts in under a second
and answers `"s3 sink proxy"` with `connect/connect-aws-s3-sink/s3-sink-proxy.sh`.
95% of those scripts are indexed with their connector class; the rest are the
client, ksqlDB, Flink and environment examples, which have no connector.

## Secrets

`playground.ini` stores Confluent Cloud API keys in cleartext, connector configs
carry passwords, and logs leak JAAS strings. Every response passes through a
redaction layer that masks secret-looking config keys, JAAS/JDBC inline
passwords, `key:secret` pairs, credentials in URLs and `Authorization` headers.
Shell variable references (`$AWS_SECRET_ACCESS_KEY`) and ordinary settings
(`key.converter`) are left readable.

All tools are **read-only**. Nothing here starts, stops, or reconfigures
anything.

## Installation

### Claude Code, from the playground repository

Nothing to install. [kafka-docker-playground](https://github.com/vdesabou/kafka-docker-playground)
ships a `.mcp.json` at its root that declares this server, so running `claude`
from the checkout offers it — accept it once. `playground ai` accepts it for you.

### Any MCP client

```json
{
  "mcpServers": {
    "mcp-playground": {
      "command": "npx",
      "args": ["-y", "github:vdesabou/kafka-docker-playground-mcp-server"]
    }
  }
}
```

No path is needed when the client starts the server inside the playground
checkout: the repo root is found by walking up from the working directory. When
it does not — Claude desktop, for instance — add
`"env": { "PLAYGROUND_REPO_ROOT": "/path/to/kafka-docker-playground" }`.

### A local clone, for working on the server itself

A `local` scope server shadows the one from `.mcp.json`, so point it at your
build and the playground repository keeps working unchanged:

```bash
npm install && npm run build
claude mcp add mcp-playground -- node /path/to/kafka-docker-playground-mcp-server/dist/index.js
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PLAYGROUND_REPO_ROOT` | Absolute path to the playground checkout. Optional — the server also walks up from its working directory and checks `~/kafka-docker-playground`. Set it explicitly if the server starts anywhere else. |
| `KAFKA_DOCKER_PLAYGROUND_DIR` | Accepted as an alias for the above. |
| `CONFLUENT_CLOUD_API_KEY` / `CONFLUENT_CLOUD_API_SECRET` | Required only by `playground_connectors` when the current run uses a **fully managed** or **custom** connector. |

The server needs the `docker` CLI on its `PATH` and a reachable daemon — it
inspects the playground's containers, so it runs on the host rather than in a
container of its own.

## Development

```bash
npm run dev              # run from source with tsx
npm run watch            # reload on change
npm run fastmcp:inspect  # web inspector
```

```
src/
├── index.ts      # tool definitions
├── config.ts     # repo root resolution
├── state.ts      # playground.ini + run history
├── docker.ts     # docker CLI wrapper
├── connect.ts    # Connect REST (on-prem + Confluent Cloud) endpoint resolution
├── logs.ts       # error extraction, de-duplication, stack-trace collapsing
├── examples.ts   # example index, search and detail extraction
├── http.ts       # request helper with client-certificate support
├── redact.ts     # secret redaction
└── exec.ts       # shell-free subprocess helper
```

## Related

For *modifying* the `playground` CLI (bashly conventions, regeneration,
where helpers go), use the `playground-cli` skill in
`kafka-docker-playground/.claude/skills/playground-cli/` instead. The two do not
overlap: the skill covers authoring the CLI, this server covers observing a
running environment.

Built with [FastMCP](https://github.com/punkpeye/fastmcp).

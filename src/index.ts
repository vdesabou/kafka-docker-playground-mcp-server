import { FastMCP } from "fastmcp";
import { z } from "zod";

import { EXAMPLE_CATEGORIES, repoRoot } from "./config.js";
import { fetchConnectors, resolveEndpoint } from "./connect.js";
import { containerLogs, dockerStatus, listContainers } from "./docker.js";
import { details, search } from "./examples.js";
import { grep, scanForErrors, tail } from "./logs.js";
import { currentRun, readState, recentRuns, redactedState } from "./state.js";

const server = new FastMCP({
  name: "kafka-docker-playground",
  version: "2.0.0",
});

function reply(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/** Tools report failures as data so the caller can act on them rather than retrying blindly. */
async function guarded<T>(work: () => Promise<T> | T): Promise<string> {
  try {
    return reply(await work());
  } catch (error) {
    return reply({ error: (error as Error).message });
  }
}

server.addTool({
  name: "playground_status",
  description:
    "Snapshot of the local kafka-docker-playground environment: whether Docker is up, " +
    "which example was last run (script, environment, connector type), every container " +
    "with its state/health/ports, and the recent `playground run` history. Call this " +
    "first when asked what is running, why an example is failing, or before touching a " +
    "running environment. Secrets from playground.ini are redacted.",
  parameters: z.object({
    include_state: z
      .boolean()
      .optional()
      .describe("Also return the full redacted playground.ini contents (default false)"),
  }),
  execute: async ({ include_state }) =>
    guarded(async () => {
      const root = repoRoot();
      const state = readState();
      const docker = await dockerStatus();
      const containers = docker.available ? await listContainers() : [];

      return {
        repo_root: root,
        docker,
        current_run: currentRun(state),
        containers: {
          running: containers.filter((container) => container.state === "running"),
          not_running: containers.filter((container) => container.state !== "running"),
        },
        recent_runs: recentRuns(10),
        ...(include_state ? { playground_ini: redactedState(state) } : {}),
      };
    }),
});

server.addTool({
  name: "playground_connectors",
  description:
    "Status of every connector on the cluster the playground is currently pointed at, " +
    "with each task's state and — for FAILED tasks — the root cause extracted from the " +
    "stack trace instead of the full trace. Automatically picks the right endpoint: the " +
    "running Connect worker (handling the ssl/rbac environments) for self-managed " +
    "connectors, or the Confluent Cloud Connect API for fully managed ones. Connector " +
    "configurations are returned redacted on request.",
  parameters: z.object({
    connector: z
      .string()
      .optional()
      .describe("Restrict to one connector by name; omit for all connectors"),
    include_config: z
      .boolean()
      .optional()
      .describe("Include the redacted connector configuration (default false)"),
  }),
  execute: async ({ connector, include_config }) =>
    guarded(async () => {
      const endpoint = await resolveEndpoint(readState());
      const connectors = await fetchConnectors(endpoint, {
        connector,
        includeConfig: include_config ?? false,
      });

      return {
        endpoint: {
          kind: endpoint.kind,
          base_url: endpoint.base_url,
          worker: endpoint.worker,
          environment: endpoint.environment,
        },
        connector_count: connectors.length,
        failed: connectors.filter(
          (item) => item.state === "FAILED" || item.failed_task_count > 0
        ).length,
        connectors,
      };
    }),
});

server.addTool({
  name: "playground_logs",
  description:
    "Read a playground container's logs without pulling tens of thousands of lines into " +
    "context. Default mode `errors` returns de-duplicated ERROR/FATAL records with their " +
    "stack traces collapsed to the exception chain and an occurrence count — use it to " +
    "diagnose a failing run. Mode `tail` returns the last N raw lines; mode `search` " +
    "returns lines matching a regex. Typical containers: connect, broker, schema-registry, " +
    "control-center, ksqldb-server.",
  parameters: z.object({
    container: z.string().describe("Container name, e.g. 'connect' or 'broker'"),
    mode: z
      .enum(["errors", "tail", "search"])
      .optional()
      .describe("errors (default), tail, or search"),
    pattern: z.string().optional().describe("Regex to match, required for mode 'search'"),
    lines: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Max results: findings for 'errors', lines for 'tail'/'search' (default 40)"),
    since: z
      .string()
      .optional()
      .describe("Only logs newer than this docker duration or timestamp, e.g. '10m', '1h'"),
    include_warnings: z
      .boolean()
      .optional()
      .describe("In 'errors' mode, also report WARN records (default false)"),
  }),
  execute: async ({ container, mode, pattern, lines, since, include_warnings }) =>
    guarded(async () => {
      const limit = lines ?? 40;
      const result = await containerLogs(container, { since, tail: 20_000 });
      if (!result.ok) {
        return { container, error: result.error };
      }

      const selected = mode ?? "errors";
      if (selected === "tail") {
        return { container, mode: selected, since, lines: tail(result.text, limit) };
      }
      if (selected === "search") {
        if (!pattern) return { container, error: "mode 'search' requires a 'pattern'" };
        const found = grep(result.text, pattern, limit);
        return {
          container,
          mode: selected,
          pattern,
          total_matching_lines: found.total,
          returned: found.matches.length,
          lines: found.matches,
        };
      }

      const scan = scanForErrors(result.text, {
        limit,
        includeWarnings: include_warnings ?? false,
      });
      return { container, mode: selected, since, ...scan };
    }),
});

server.addTool({
  name: "playground_find_example",
  description:
    "Search the ~2000 runnable example scripts across connect/, ccloud/, ksqldb/, flink/, " +
    "reproduction-models/ and the other playgrounds. Matches connector class, script path, " +
    "README title and script body, so queries like 'oracle cdc ssl', 'fully managed s3 sink' " +
    "or 'jdbc source with proxy' work. Returns the exact `playground run -f <script>` " +
    "command for each hit. Use this instead of grepping the repository.",
  parameters: z.object({
    query: z.string().describe("Free-text query, e.g. 'debezium postgres fully managed'"),
    category: z
      .enum(EXAMPLE_CATEGORIES)
      .optional()
      .describe("Restrict to one top-level playground directory"),
    limit: z.number().int().positive().max(40).optional().describe("Max hits (default 10)"),
  }),
  execute: async ({ query, category, limit }) =>
    guarded(() => {
      const hits = search(query, limit ?? 10, category);
      return { query, category: category ?? null, hit_count: hits.length, hits };
    }),
});

server.addTool({
  name: "playground_example_details",
  description:
    "Everything needed to run or understand one example in a single call: the script " +
    "source, the connector payloads it posts (redacted), the default environment, the " +
    "docker-compose override files it layers in, the sibling variants in the same folder, " +
    "which credential handlers it calls, and which environment variables the caller must " +
    "export. Accepts a repo-relative script path from playground_find_example, or a bare " +
    "script name such as 's3-sink'.",
  parameters: z.object({
    example: z
      .string()
      .describe("Script path (e.g. 'connect/connect-aws-s3-sink/s3-sink.sh') or name"),
    max_script_chars: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .optional()
      .describe("Truncate the returned script source (default 12000)"),
  }),
  execute: async ({ example, max_script_chars }) =>
    guarded(() => {
      const found = details(example, max_script_chars ?? 12_000);
      if (!found) {
        return {
          error: `No example matched '${example}'. Use playground_find_example to locate one.`,
        };
      }
      return found;
    }),
});

async function main() {
  // stdio transport: anything written to stdout would corrupt the protocol.
  console.error(`kafka-docker-playground MCP server starting`);
  await server.start({ transportType: "stdio" });
}

main().catch((error) => {
  console.error("Server failed:", error);
  process.exit(1);
});

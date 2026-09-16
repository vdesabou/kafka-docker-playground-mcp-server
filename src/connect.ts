import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";
import { hostPort, isRunning } from "./docker.js";
import { getJson, HttpOptions } from "./http.js";
import { summarizeTrace } from "./logs.js";
import { redactRecord } from "./redact.js";
import { CONNECTOR_TYPES, currentRun, IniSections } from "./state.js";

export interface ConnectEndpoint {
  kind: "onprem" | "confluent-cloud";
  base_url: string;
  worker?: string;
  environment?: string;
  http: HttpOptions;
}

/** Default host port published by each Connect worker in the playground compose files. */
const WORKER_PORTS: Array<[string, number]> = [
  ["connect", 8083],
  ["connect-us", 8083],
  ["connect2", 8283],
  ["connect-europe", 8283],
  ["connect3", 8383],
];

async function resolveOnPrem(environment: string): Promise<ConnectEndpoint> {
  let worker: string | null = null;
  let port: number | null = null;

  for (const [name, defaultPort] of WORKER_PORTS) {
    if (!(await isRunning(name))) continue;
    worker = name;
    port = (await hostPort(name, 8083)) ?? defaultPort;
    break;
  }

  if (!worker || !port) {
    throw new Error(
      "No Connect worker container is running (looked for connect, connect-us, " +
        "connect2, connect-europe, connect3). Start an example with `playground run` first."
    );
  }

  const securityDir = path.join(repoRoot(), "environment", environment, "security");
  const useTls = environment === "sasl-ssl" || environment === "2way-ssl";

  const http: HttpOptions = {};
  if (useTls) {
    http.tls = {
      certFile: path.join(securityDir, "connect.certificate.pem"),
      keyFile: path.join(securityDir, "connect.key"),
      caFile: path.join(securityDir, "snakeoil-ca-1.crt"),
    };
  }
  if (environment === "rbac-sasl-plain") {
    http.basicAuth = { user: "connectorSubmitter", password: "connectorSubmitter" };
  }

  return {
    kind: "onprem",
    base_url: `${useTls ? "https" : "http"}://localhost:${port}`,
    worker,
    environment,
    http,
  };
}

function resolveConfluentCloud(): ConnectEndpoint {
  const delta = path.join(repoRoot(), ".ccloud", "ak-tools-ccloud.delta");
  if (!existsSync(delta)) {
    throw new Error(
      `The current run uses a fully managed connector but ${delta} does not exist, ` +
        "so the Confluent Cloud environment and cluster ids are unknown."
    );
  }

  // The delta file records the ids as comments: `# ENVIRONMENT ID: env-xxxxx`.
  const content = readFileSync(delta, "utf8");
  const environment = /ENVIRONMENT ID:\s*(\S+)/.exec(content)?.[1];
  const cluster = /KAFKA CLUSTER ID:\s*(\S+)/.exec(content)?.[1];
  if (!environment || !cluster) {
    throw new Error(`Could not read ENVIRONMENT ID / KAFKA CLUSTER ID from ${delta}.`);
  }

  const key = process.env.CONFLUENT_CLOUD_API_KEY;
  const secret = process.env.CONFLUENT_CLOUD_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      "CONFLUENT_CLOUD_API_KEY and CONFLUENT_CLOUD_API_SECRET must be set in the MCP " +
        "server environment to query fully managed connectors."
    );
  }

  return {
    kind: "confluent-cloud",
    base_url: `https://api.confluent.cloud/connect/v1/environments/${environment}/clusters/${cluster}`,
    environment,
    http: { basicAuth: { user: key, password: secret } },
  };
}

export async function resolveEndpoint(state: IniSections): Promise<ConnectEndpoint> {
  const run = currentRun(state);
  const type = run.connector_type ?? CONNECTOR_TYPES.ONPREM;

  if (type === CONNECTOR_TYPES.FULLY_MANAGED || type === CONNECTOR_TYPES.CUSTOM) {
    return resolveConfluentCloud();
  }

  const environment = run.environment_before_switch || run.environment || "plaintext";
  return resolveOnPrem(environment);
}

interface RawTask {
  id: number;
  state: string;
  worker_id?: string;
  trace?: string;
}

interface RawStatus {
  name: string;
  type?: string;
  connector?: { state: string; worker_id?: string; trace?: string };
  tasks?: RawTask[];
}

export interface TaskSummary {
  id: number;
  state: string;
  worker_id?: string;
  root_cause?: string;
  trace?: string;
}

export interface ConnectorSummary {
  name: string;
  type?: string;
  state: string;
  worker_id?: string;
  tasks: TaskSummary[];
  failed_task_count: number;
  connector_class?: string;
  topics?: string;
  config?: Record<string, unknown>;
  error?: string;
}

/** First line of the deepest `Caused by:` — the sentence worth reading. */
function rootCause(trace: string): string {
  const causes = trace
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Caused by:"));
  if (causes.length > 0) return causes[causes.length - 1].replace(/^Caused by:\s*/, "");
  return trace.split(/\r?\n/)[0]?.trim() ?? "";
}

function toSummary(status: RawStatus, config?: Record<string, unknown>): ConnectorSummary {
  const tasks: TaskSummary[] = (status.tasks ?? []).map((task) => {
    const summary: TaskSummary = {
      id: task.id,
      state: task.state,
      worker_id: task.worker_id,
    };
    if (task.trace) {
      summary.root_cause = rootCause(task.trace);
      summary.trace = summarizeTrace(task.trace);
    }
    return summary;
  });

  const summary: ConnectorSummary = {
    name: status.name,
    type: status.type,
    state: status.connector?.state ?? "UNKNOWN",
    worker_id: status.connector?.worker_id,
    tasks,
    failed_task_count: tasks.filter((task) => task.state === "FAILED").length,
  };

  if (status.connector?.trace) {
    summary.error = rootCause(status.connector.trace);
  }
  if (config) {
    summary.connector_class = String(config["connector.class"] ?? config["connector_class"] ?? "") || undefined;
    summary.topics = (config["topics"] ?? config["topics.regex"] ?? undefined) as string | undefined;
    summary.config = redactRecord(config);
  }
  return summary;
}

export async function listConnectorNames(endpoint: ConnectEndpoint): Promise<string[]> {
  const names = await getJson<string[]>(`${endpoint.base_url}/connectors`, endpoint.http);
  return Array.isArray(names) ? names : [];
}

export interface FetchOptions {
  /** Only this connector; otherwise every connector on the cluster. */
  connector?: string;
  /** Include the (redacted) connector configuration in the result. */
  includeConfig?: boolean;
}

export async function fetchConnectors(
  endpoint: ConnectEndpoint,
  options: FetchOptions = {}
): Promise<ConnectorSummary[]> {
  const names = options.connector
    ? [options.connector]
    : await listConnectorNames(endpoint);

  const summaries: ConnectorSummary[] = [];
  for (const name of names) {
    const encoded = encodeURIComponent(name);
    try {
      const status = await getJson<RawStatus>(
        `${endpoint.base_url}/connectors/${encoded}/status`,
        endpoint.http
      );
      let config: Record<string, unknown> | undefined;
      if (options.includeConfig) {
        config = await getJson<Record<string, unknown>>(
          `${endpoint.base_url}/connectors/${encoded}/config`,
          endpoint.http
        );
      }
      summaries.push(toSummary({ ...status, name: status.name ?? name }, config));
    } catch (error) {
      summaries.push({
        name,
        state: "UNKNOWN",
        tasks: [],
        failed_task_count: 0,
        error: (error as Error).message,
      });
    }
  }
  return summaries;
}

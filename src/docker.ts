import { run } from "./exec.js";

export interface ContainerInfo {
  name: string;
  image: string;
  service: string | null;
  project: string | null;
  state: string;
  status: string;
  health: string | null;
  ports: string[];
}

export interface DockerStatus {
  available: boolean;
  server_version?: string;
  error?: string;
}

export async function dockerStatus(): Promise<DockerStatus> {
  const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout).trim().split(/\r?\n/)[0];
    return {
      available: false,
      error: message || "docker is not reachable (is Docker Desktop running?)",
    };
  }
  return { available: true, server_version: result.stdout.trim() };
}

interface DockerPsRow {
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
  Labels?: string;
}

function labelValue(labels: string | undefined, key: string): string | null {
  if (!labels) return null;
  for (const entry of labels.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator) === key) return entry.slice(separator + 1);
  }
  return null;
}

function healthFromStatus(status: string): string | null {
  const match = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  return match ? match[1] : null;
}

/**
 * Includes stopped containers on purpose: "the connect container exited 3
 * minutes ago" is the single most useful fact when an example fails.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const result = await run("docker", ["ps", "--all", "--format", "{{json .}}"]);
  if (result.code !== 0) return [];

  const containers: ContainerInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: DockerPsRow;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const status = row.Status ?? "";
    containers.push({
      name: row.Names ?? "",
      image: row.Image ?? "",
      service: labelValue(row.Labels, "com.docker.compose.service"),
      project: labelValue(row.Labels, "com.docker.compose.project"),
      state: row.State ?? "",
      status,
      health: healthFromStatus(status),
      ports: (row.Ports ?? "")
        .split(", ")
        .map((port) => port.trim())
        .filter(Boolean),
    });
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

export async function isRunning(name: string): Promise<boolean> {
  const result = await run("docker", [
    "ps",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.code === 0 && result.stdout.trim() === name;
}

export interface LogsOptions {
  tail?: number;
  since?: string;
}

export async function containerLogs(
  name: string,
  options: LogsOptions = {}
): Promise<{ ok: boolean; text: string; error?: string }> {
  const args = ["logs"];
  if (options.since) args.push("--since", options.since);
  args.push("--tail", String(options.tail ?? 5000), name);

  const result = await run("docker", args, { timeoutMs: 30_000 });
  if (result.code !== 0 && !result.stdout && !result.stderr) {
    return { ok: false, text: "", error: `docker logs ${name} failed` };
  }
  if (result.code !== 0 && /No such container/i.test(result.stderr)) {
    return { ok: false, text: "", error: result.stderr.trim() };
  }
  // Container logs arrive split across both streams; both are wanted.
  return { ok: true, text: `${result.stdout}${result.stderr}` };
}

/** Host port bound to `containerPort`, or null when the port is not published. */
export async function hostPort(
  name: string,
  containerPort: number
): Promise<number | null> {
  const result = await run("docker", ["port", name, String(containerPort)]);
  if (result.code !== 0) return null;
  const match = /:(\d+)\s*$/m.exec(result.stdout.trim());
  return match ? Number(match[1]) : null;
}

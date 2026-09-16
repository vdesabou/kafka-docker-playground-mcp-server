import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * A directory is the playground repo root if it carries the bashly source of
 * truth for the CLI. That file exists in every checkout and nowhere else.
 */
const MARKER = path.join("scripts", "cli", "src", "bashly.yml");

function isRepoRoot(dir: string): boolean {
  return existsSync(path.join(dir, MARKER));
}

function walkUp(from: string): string | null {
  let current = path.resolve(from);
  while (true) {
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

let cached: string | null = null;

/**
 * Resolution order: explicit env var, then upward from cwd, then the two
 * conventional checkout locations. Throws with actionable text rather than
 * silently falling back to a stub — a wrong repo root makes every answer wrong.
 */
export function repoRoot(): string {
  if (cached) return cached;

  const fromEnv =
    process.env.PLAYGROUND_REPO_ROOT || process.env.KAFKA_DOCKER_PLAYGROUND_DIR;
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (!isRepoRoot(resolved)) {
      throw new Error(
        `PLAYGROUND_REPO_ROOT=${resolved} is not a kafka-docker-playground checkout ` +
          `(${MARKER} not found there).`
      );
    }
    cached = resolved;
    return cached;
  }

  const found = walkUp(process.cwd());
  if (found) {
    cached = found;
    return cached;
  }

  for (const candidate of [
    path.join(homedir(), "kafka-docker-playground"),
    path.join(homedir(), "git", "kafka-docker-playground"),
  ]) {
    if (isRepoRoot(candidate)) {
      cached = candidate;
      return cached;
    }
  }

  throw new Error(
    "Could not locate the kafka-docker-playground checkout. Set the " +
      "PLAYGROUND_REPO_ROOT environment variable in the MCP server configuration " +
      "to the absolute path of the repository."
  );
}

/** Same as repoRoot() but reports the failure as data instead of throwing. */
export function repoRootOrError(): { root: string } | { error: string } {
  try {
    return { root: repoRoot() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export const EXAMPLE_CATEGORIES = [
  "connect",
  "ccloud",
  "ksqldb",
  "flink",
  "schema-registry",
  "rest-proxy",
  "multi-data-center",
  "other",
  "operator",
  "academy",
  "environment",
  "reproduction-models",
] as const;

export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];

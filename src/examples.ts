import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EXAMPLE_CATEGORIES, repoRoot } from "./config.js";
import { redactRecord, redactText } from "./redact.js";

export interface ExampleEntry {
  /** Repo-relative path of the runnable script — the argument to `playground run -f`. */
  script: string;
  dir: string;
  category: string;
  name: string;
  title: string | null;
  connector_classes: string[];
  environment: string | null;
  /** Lowercased haystack used for scoring; never returned to the caller. */
  haystack: string;
}

/**
 * Every runnable example sources the shared helper library. Directories also
 * contain teardown scripts and helper scripts that are not entry points.
 */
const RUNNABLE_MARKER = "scripts/utils.sh";
const EXCLUDED_SCRIPTS = new Set(["stop.sh"]);
const MAX_DEPTH = 3;
const HAYSTACK_LIMIT = 8_000;

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readmeTitle(dir: string): string | null {
  for (const candidate of ["README.md", "readme.md"]) {
    const file = path.join(dir, candidate);
    try {
      const content = readFileSync(file, "utf8");
      const heading = /^#\s+(.+)$/m.exec(content);
      return heading ? heading[1].trim() : null;
    } catch {
      // No README in this directory.
    }
  }
  return null;
}

function readmeBody(dir: string): string {
  for (const candidate of ["README.md", "readme.md"]) {
    try {
      return readFileSync(path.join(dir, candidate), "utf8").slice(0, HAYSTACK_LIMIT);
    } catch {
      // No README in this directory.
    }
  }
  return "";
}

/** `config-io.confluent.connect.s3.S3SinkConnector.json` -> the connector class. */
function connectorClassesFromFiles(files: string[]): string[] {
  const classes = new Set<string>();
  for (const file of files) {
    const match = /^config-(.+)\.(json|txt)$/.exec(file);
    if (match) classes.add(match[1]);
  }
  return [...classes];
}

/**
 * The `config-<CLASS>` convention only covers part of the repository: the
 * `ccloud/fm-*` examples follow it, but the Confluent Cloud custom-connector
 * examples, most of `reproduction-models/` and a long tail elsewhere carry the
 * class only inside the payload they post. Reading it from the script also
 * makes the class *per script* rather than per directory, which matters when a
 * folder holds several variants.
 */
function connectorClassesFromScript(content: string): string[] {
  const classes = new Set<string>();
  const pattern = /"connector\.class"\s*:\s*"([^"$]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const value = match[1].trim();
    if (value) classes.add(value);
  }
  return [...classes];
}

function defaultEnvironment(script: string): string | null {
  const match = /PLAYGROUND_ENVIRONMENT:-"?([A-Za-z0-9_-]+)"?/.exec(script);
  return match ? match[1] : null;
}

function scanDirectory(
  absoluteDir: string,
  category: string,
  depth: number,
  into: ExampleEntry[]
): void {
  if (depth > MAX_DEPTH) return;

  const files = listFiles(absoluteDir);
  const shellScripts = files.filter(
    (file) => file.endsWith(".sh") && !EXCLUDED_SCRIPTS.has(file)
  );

  if (shellScripts.length > 0) {
    const directoryClasses = connectorClassesFromFiles(files);
    const title = readmeTitle(absoluteDir);
    const readme = readmeBody(absoluteDir);
    const relativeDir = path.relative(repoRoot(), absoluteDir);

    for (const file of shellScripts) {
      let content: string;
      try {
        content = readFileSync(path.join(absoluteDir, file), "utf8");
      } catch {
        continue;
      }
      if (!content.includes(RUNNABLE_MARKER)) continue;

      const name = file.replace(/\.sh$/, "");
      // The script's own payload wins; the directory convention fills the gap
      // for the examples that post no inline configuration.
      const classes = [
        ...new Set([...connectorClassesFromScript(content), ...directoryClasses]),
      ];
      into.push({
        script: path.join(relativeDir, file),
        dir: relativeDir,
        category,
        name,
        title,
        connector_classes: classes,
        environment: defaultEnvironment(content),
        haystack: [
          relativeDir,
          name,
          title ?? "",
          classes.join(" "),
          content.slice(0, HAYSTACK_LIMIT),
          readme,
        ]
          .join("\n")
          .toLowerCase(),
      });
    }
  }

  for (const child of listDirs(absoluteDir)) {
    scanDirectory(path.join(absoluteDir, child), category, depth + 1, into);
  }
}

let index: ExampleEntry[] | null = null;
let indexedAt = 0;
const INDEX_TTL_MS = 10 * 60 * 1000;

export function buildIndex(force = false): ExampleEntry[] {
  if (index && !force && Date.now() - indexedAt < INDEX_TTL_MS) return index;

  const root = repoRoot();
  const entries: ExampleEntry[] = [];
  for (const category of EXAMPLE_CATEGORIES) {
    const absolute = path.join(root, category);
    try {
      if (!statSync(absolute).isDirectory()) continue;
    } catch {
      continue; // e.g. reproduction-models, a submodule that may not be checked out.
    }
    scanDirectory(absolute, category, 0, entries);
  }

  index = entries;
  indexedAt = Date.now();
  return entries;
}

export interface SearchHit {
  script: string;
  category: string;
  title: string | null;
  connector_classes: string[];
  environment: string | null;
  score: number;
  run: string;
}

/**
 * Terms are scored by *where* they match: the script path and connector class
 * are strong signals, README prose is a weak one. Every term must match
 * somewhere, so "s3 proxy" does not return every S3 example.
 */
export function search(query: string, limit = 10, category?: string): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9.+_-]+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const entry of buildIndex()) {
    if (category && entry.category !== category) continue;

    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      const inPath = entry.script.toLowerCase().includes(term);
      const inClass = entry.connector_classes.join(" ").toLowerCase().includes(term);
      const inTitle = (entry.title ?? "").toLowerCase().includes(term);
      const inBody = entry.haystack.includes(term);

      if (!inPath && !inClass && !inTitle && !inBody) {
        matchedAll = false;
        break;
      }
      if (inPath) score += 10;
      if (inClass) score += 6;
      if (inTitle) score += 4;
      if (inBody) score += 1;
    }

    if (!matchedAll) continue;
    // Prefer the canonical variant of a family over its many derivatives.
    score -= entry.name.split("-").length * 0.1;

    hits.push({
      script: entry.script,
      category: entry.category,
      title: entry.title,
      connector_classes: entry.connector_classes,
      environment: entry.environment,
      score: Math.round(score * 10) / 10,
      run: `playground run -f ${entry.script}`,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function findEntry(reference: string): ExampleEntry | null {
  const entries = buildIndex();
  const needle = reference.replace(/^\.?\//, "");

  const exact = entries.find(
    (entry) => entry.script === needle || path.join(repoRoot(), entry.script) === reference
  );
  if (exact) return exact;

  const bySuffix = entries.filter((entry) => entry.script.endsWith(needle));
  if (bySuffix.length === 1) return bySuffix[0];

  const byName = entries.filter(
    (entry) => entry.name === needle || entry.name === needle.replace(/\.sh$/, "")
  );
  if (byName.length >= 1) return byName[0];

  return bySuffix[0] ?? null;
}

/** Connector payloads passed to `playground connector create-or-update ... << EOF`. */
function extractConnectorConfigs(
  script: string
): Array<{ connector: string; config: Record<string, unknown> | string }> {
  const out: Array<{ connector: string; config: Record<string, unknown> | string }> = [];
  const pattern =
    /playground connector create-or-update\s+--connector\s+(\S+)[^\n]*<<\s*'?EOF'?\n([\s\S]*?)\nEOF/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    const [, connector, body] = match;
    try {
      out.push({ connector, config: redactRecord(JSON.parse(body)) as Record<string, unknown> });
    } catch {
      // Shell variables inside the payload make it invalid JSON; keep the raw text.
      out.push({ connector, config: redactText(body.trim()) });
    }
  }
  return out;
}

/** Credential handlers the script calls, which tell the caller what must be configured. */
function credentialHandlers(script: string): string[] {
  const handlers = new Set<string>();
  const pattern = /^\s*(handle_\w*credentials\w*)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) handlers.add(match[1]);
  return [...handlers];
}

/** Variables the script reads but never assigns — i.e. the caller must export them. */
const PROVIDED_BY_PLAYGROUND = new Set([
  "DIR", "PWD", "USER", "HOME", "PATH", "TAG", "CONNECTOR_TAG", "CONNECTOR_ZIP",
  "CONNECTOR_JAR", "PLAYGROUND_ENVIRONMENT", "BASH_SOURCE", "AWS_REGION",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "TMPDIR",
  "GITHUB_RUN_NUMBER", "CI", "OSTYPE", "SHLVL", "RANDOM", "LINENO",
]);

function externalVariables(script: string): string[] {
  const assigned = new Set<string>();
  const assignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})=/gm;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(script)) !== null) assigned.add(match[1]);

  const used = new Set<string>();
  const usage = /\$\{?([A-Z][A-Z0-9_]{2,})\b/g;
  while ((match = usage.exec(script)) !== null) {
    const name = match[1];
    if (assigned.has(name) || PROVIDED_BY_PLAYGROUND.has(name)) continue;
    used.add(name);
  }
  return [...used].sort();
}

export interface ExampleDetails {
  script: string;
  dir: string;
  category: string;
  title: string | null;
  environment: string | null;
  run: string;
  connector_classes: string[];
  compose_override_files: string[];
  sibling_variants: string[];
  credential_handlers: string[];
  required_environment_variables: string[];
  connectors: Array<{ connector: string; config: Record<string, unknown> | string }>;
  topics_produced: string[];
  script_source: string;
  script_truncated: boolean;
}

export function details(reference: string, maxScriptChars = 12_000): ExampleDetails | null {
  const entry = findEntry(reference);
  if (!entry) return null;

  const absolute = path.join(repoRoot(), entry.script);
  let source: string;
  try {
    source = readFileSync(absolute, "utf8");
  } catch {
    return null;
  }

  const overrides = new Set<string>();
  const overridePattern = /--docker-compose-override-file\s+"?\$?\{?PWD\}?\/([^"\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = overridePattern.exec(source)) !== null) overrides.add(match[1]);

  const topics = new Set<string>();
  const topicPattern = /playground topic produce\s+-t\s+(\S+)/g;
  while ((match = topicPattern.exec(source)) !== null) topics.add(match[1]);

  const siblings = buildIndex()
    .filter((other) => other.dir === entry.dir && other.script !== entry.script)
    .map((other) => other.script);

  return {
    script: entry.script,
    dir: entry.dir,
    category: entry.category,
    title: entry.title,
    environment: entry.environment,
    run: `playground run -f ${entry.script}`,
    connector_classes: entry.connector_classes,
    compose_override_files: [...overrides],
    sibling_variants: siblings,
    credential_handlers: credentialHandlers(source),
    required_environment_variables: externalVariables(source),
    connectors: extractConnectorConfigs(source),
    topics_produced: [...topics],
    script_source: redactText(source.slice(0, maxScriptChars)),
    script_truncated: source.length > maxScriptChars,
  };
}

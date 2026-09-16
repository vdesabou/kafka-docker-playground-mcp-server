import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./config.js";
import { isSecretKey, redactText, REDACTED } from "./redact.js";

export type IniSections = Record<string, Record<string, string>>;

/**
 * Mirrors the parser in `scripts/cli/src/lib/ini.sh`: optional `[section]`
 * headers, `key = value` pairs, `;` comments. Values may contain `=`
 * (base64 blobs, JSON), so only the first separator splits.
 */
export function parseIni(content: string): IniSections {
  const sections: IniSections = { "": {} };
  let current = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] ??= {};
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) sections[current][key] = value;
  }

  if (Object.keys(sections[""]).length === 0) delete sections[""];
  return sections;
}

export function iniPath(): string {
  return path.join(repoRoot(), "playground.ini");
}

export function readState(): IniSections {
  const file = iniPath();
  if (!existsSync(file)) return {};
  return parseIni(readFileSync(file, "utf8"));
}

export function stateValue(sections: IniSections, dotted: string): string {
  const separator = dotted.indexOf(".");
  if (separator === -1) return sections[""]?.[dotted] ?? "";
  const section = dotted.slice(0, separator);
  const key = dotted.slice(separator + 1);
  return sections[section]?.[key] ?? "";
}

/**
 * `playground.ini` holds Confluent Cloud API keys and secrets verbatim, so the
 * whole file is redacted before it can reach a model context. Large base64
 * blobs are elided too — they are never useful to read.
 */
export function redactedState(sections: IniSections): IniSections {
  const out: IniSections = {};
  for (const [section, entries] of Object.entries(sections)) {
    out[section] = {};
    for (const [key, value] of Object.entries(entries)) {
      if (isSecretKey(key)) {
        out[section][key] = REDACTED;
      } else if (key.endsWith("_base64") || value.length > 512) {
        out[section][key] = `<${value.length} chars elided>`;
      } else {
        out[section][key] = redactText(value);
      }
    }
  }
  return out;
}

export const CONNECTOR_TYPES = {
  FULLY_MANAGED: "fully managed",
  CUSTOM: "custom",
  SELF_MANAGED: "self managed",
  ONPREM: "onprem",
} as const;

/** Strips the emoji prefix the CLI stores with connector types and environments. */
export function normalizeConnectorType(raw: string): string {
  return raw.replace(/[^\x20-\x7E]/g, "").trim();
}

export interface CurrentRun {
  test_file: string | null;
  example: string | null;
  category: string | null;
  environment: string | null;
  environment_before_switch: string | null;
  connector_type: string | null;
  connector_docs_links: string[];
}

export function currentRun(sections: IniSections): CurrentRun {
  const testFile = stateValue(sections, "run.test_file") || null;
  let example: string | null = null;
  let category: string | null = null;

  if (testFile) {
    const relative = path.relative(repoRoot(), testFile);
    if (!relative.startsWith("..")) {
      const parts = relative.split(path.sep);
      category = parts[0] ?? null;
      example = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
    }
  }

  const docs = stateValue(sections, "run.connector_docs_links");

  return {
    test_file: testFile,
    example,
    category,
    environment: stateValue(sections, "run.environment") || null,
    environment_before_switch:
      stateValue(sections, "run.environment_before_switch") || null,
    connector_type:
      normalizeConnectorType(stateValue(sections, "run.connector_type")) || null,
    connector_docs_links: docs ? docs.split(",").filter(Boolean) : [],
  };
}

/** Last commands from `playground-run-history`, newest first and de-duplicated. */
export function recentRuns(limit = 10): string[] {
  const file = path.join(repoRoot(), "playground-run-history");
  if (!existsSync(file)) return [];

  const lines = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (seen.has(lines[i])) continue;
    seen.add(lines[i]);
    out.push(lines[i]);
  }
  return out;
}

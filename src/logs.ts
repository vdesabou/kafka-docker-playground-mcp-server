import { redactText } from "./redact.js";

/**
 * A log "record" is a first line plus its continuation lines (stack frames,
 * `Caused by:` chains). Grouping them is what makes de-duplication and trace
 * summarisation possible.
 */
interface LogRecord {
  head: string;
  continuation: string[];
}

const CONTINUATION = /^(\s|at\s|Caused by:|\.{3}\s|Suppressed:|\})/;

function toRecords(text: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (records.length > 0 && CONTINUATION.test(line)) {
      records[records.length - 1].continuation.push(line);
    } else {
      records.push({ head: line, continuation: [] });
    }
  }
  return records;
}

const LEVEL = /\b(FATAL|ERROR|SEVERE|WARN(?:ING)?)\b/;
const THROWABLE = /\b[A-Za-z0-9_.$]*(?:Exception|Error|Throwable)\b(?=:|\s|$)/;

function levelOf(record: LogRecord): "FATAL" | "ERROR" | "WARN" | null {
  const head = record.head.slice(0, 300);
  const match = LEVEL.exec(head);
  if (match) {
    const level = match[1];
    if (level === "FATAL" || level === "SEVERE") return "FATAL";
    if (level === "ERROR") return "ERROR";
    return "WARN";
  }
  if (THROWABLE.test(head)) return "ERROR";
  return null;
}

/**
 * Keeps the exception chain and a few frames of the deepest cause, discarding
 * the hundreds of intermediate frames that carry no diagnostic information.
 */
export function summarizeTrace(trace: string, framesPerCause = 3): string {
  const lines = trace.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= framesPerCause + 2) return redactText(trace.trim());

  const out: string[] = [];
  let framesSinceCause = 0;
  let droppedFrames = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const isFrame = trimmed.startsWith("at ") || trimmed.startsWith("...");
    const isCause = trimmed.startsWith("Caused by:") || trimmed.startsWith("Suppressed:");

    if (isCause || (!isFrame && out.length === 0)) {
      if (droppedFrames > 0) {
        out.push(`\t... ${droppedFrames} frames omitted`);
        droppedFrames = 0;
      }
      out.push(trimmed);
      framesSinceCause = 0;
      continue;
    }

    if (isFrame) {
      if (framesSinceCause < framesPerCause) {
        out.push(`\t${trimmed}`);
        framesSinceCause++;
      } else {
        droppedFrames++;
      }
      continue;
    }

    // Non-frame, non-cause line in the middle of a trace (e.g. a message
    // continuation) — keep it, it is usually the useful part.
    out.push(trimmed);
  }

  if (droppedFrames > 0) out.push(`\t... ${droppedFrames} frames omitted`);
  return redactText(out.join("\n"));
}

/** Normalises volatile parts so that "the same error, 400 times" collapses to one entry. */
function dedupeKey(head: string): string {
  return head
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[.,]\d+/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d+\b/g, "<n>")
    .trim();
}

export interface LogFinding {
  level: "FATAL" | "ERROR" | "WARN";
  first_seen_line: number;
  occurrences: number;
  message: string;
  trace?: string;
}

export interface ErrorScanResult {
  total_lines: number;
  findings: LogFinding[];
  truncated: boolean;
}

export interface ErrorScanOptions {
  limit?: number;
  includeWarnings?: boolean;
  maxMessageChars?: number;
}

export function scanForErrors(
  text: string,
  options: ErrorScanOptions = {}
): ErrorScanResult {
  const { limit = 25, includeWarnings = false, maxMessageChars = 1000 } = options;
  const records = toRecords(text);

  const byKey = new Map<string, LogFinding>();
  let lineNumber = 0;

  for (const record of records) {
    const recordStart = lineNumber + 1;
    lineNumber += 1 + record.continuation.length;

    const level = levelOf(record);
    if (!level) continue;
    if (level === "WARN" && !includeWarnings) continue;

    const key = `${level}:${dedupeKey(record.head)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences++;
      continue;
    }

    const finding: LogFinding = {
      level,
      first_seen_line: recordStart,
      occurrences: 1,
      message: redactText(record.head).slice(0, maxMessageChars),
    };
    if (record.continuation.length > 0) {
      finding.trace = summarizeTrace(record.continuation.join("\n"));
    }
    byKey.set(key, finding);
  }

  const severity = { FATAL: 0, ERROR: 1, WARN: 2 };
  const all = [...byKey.values()].sort((a, b) => {
    const bySeverity = severity[a.level] - severity[b.level];
    return bySeverity !== 0 ? bySeverity : a.first_seen_line - b.first_seen_line;
  });

  return {
    total_lines: lineNumber,
    findings: all.slice(0, limit),
    truncated: all.length > limit,
  };
}

export function tail(text: string, lines: number): string[] {
  const all = text.split(/\r?\n/).filter((line) => line.length > 0);
  return all.slice(-lines).map(redactText);
}

export function grep(
  text: string,
  pattern: string,
  limit: number
): { matches: string[]; total: number } {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    // Not valid regex — treat it as a literal substring.
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const matches: string[] = [];
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || !regex.test(line)) continue;
    total++;
    if (matches.length < limit) matches.push(redactText(line));
  }
  return { matches, total };
}

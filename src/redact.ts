export const REDACTED = "***redacted***";

/**
 * Substrings that make a config/state key a secret. Deliberately conservative
 * about the bare word "key": `key.converter`, `key.subject.name.strategy` and
 * friends are ordinary Connect settings, so only qualified forms match.
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /pass(word|wd|phrase)/i,
  /secret/i,
  /credential/i,
  /(^|[._-])creds([._-]|$)/i,
  /token/i,
  /(api|access|private|signing|encryption|consumer|client)[._-]?key/i,
  /key[._-]?(file|store|tab|pair|material)/i,
  /(^|[._-])authorization([._-]|$)/i,
  /sasl\.jaas\.config/i,
  /basic[._-]?auth/i,
  /\.user\.info$/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** A value that is only a shell variable reference holds no secret to hide. */
const SHELL_REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

/** Keeps enough of a value to be recognisable without disclosing it. */
function mask(value: string): string {
  if (!value) return value;
  if (SHELL_REFERENCE.test(value)) return value;
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}${REDACTED}`;
}

export function redactRecord(
  record: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSecretKey(key)) {
      out[key] = typeof value === "string" ? mask(value) : REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactRecord(value as Record<string, unknown>);
    } else if (typeof value === "string") {
      out[key] = redactText(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Words that follow `password:` in ordinary log prose rather than being one.
 * MySQL's "Access denied ... (using password: YES)" is the canonical case, and
 * that YES/NO is diagnostically useful.
 */
const NOT_A_SECRET = new Set(["yes", "no", "true", "false", "null", "none", "unset", "hidden"]);

const INLINE_SECRET_PATTERNS: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  // JAAS / JDBC style: password="..." or password='...' or password=...
  [
    /((?:pass(?:word|wd)|secret|token)\s*[=:]\s*)(["']?)([^\s"';,)]+)\2/gi,
    (_match: string, prefix: string, quote: string, value: string) =>
      NOT_A_SECRET.has(value.toLowerCase())
        ? `${prefix}${quote}${value}${quote}`
        : `${prefix}${quote}${REDACTED}${quote}`,
  ],
  // Confluent Cloud API key:secret pairs (secrets are prefixed `cflt`).
  [/\b([A-Z0-9]{16}):(cflt[A-Za-z0-9+/=]{10,})/g, `$1:${REDACTED}`],
  // HTTP Basic credentials embedded in a URL.
  [/(\/\/[^/\s:@]+):([^/\s@]+)@/g, `$1:${REDACTED}@`],
  // Bearer / Basic authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}/g, `$1 ${REDACTED}`],
];

/** Scrubs secrets that appear inline in free text such as logs or JAAS configs. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of INLINE_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

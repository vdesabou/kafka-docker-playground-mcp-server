import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Client certificate material used by the 2way-ssl / sasl-ssl environments. */
  tls?: { certFile?: string; keyFile?: string; caFile?: string };
  basicAuth?: { user: string; password: string };
}

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * Minimal request helper. Node's fetch cannot be given client certificates
 * without an undici dispatcher, and the secured playground environments need
 * them, so the core modules are used directly.
 */
export function request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const { timeoutMs = 10_000, headers = {}, tls, basicAuth } = options;
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  if (basicAuth) {
    const encoded = Buffer.from(`${basicAuth.user}:${basicAuth.password}`).toString("base64");
    requestHeaders.Authorization = `Basic ${encoded}`;
  }

  const tlsOptions: https.RequestOptions = {};
  if (isHttps) {
    try {
      if (tls?.certFile) tlsOptions.cert = readFileSync(tls.certFile);
      if (tls?.keyFile) tlsOptions.key = readFileSync(tls.keyFile);
      if (tls?.caFile) tlsOptions.ca = readFileSync(tls.caFile);
    } catch {
      // Missing certificate material: fall through to the self-signed bypass.
    }
    // The playground uses a snakeoil CA whose certificates do not match
    // `localhost`; this is a local test harness, never a production endpoint.
    tlsOptions.rejectUnauthorized = false;
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      { method: "GET", headers: requestHeaders, ...tlsOptions },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms requesting ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function getJson<T>(url: string, options?: HttpOptions): Promise<T> {
  const response = await request(url, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} from ${url}: ${response.body.slice(0, 300)}`);
  }
  return JSON.parse(response.body) as T;
}

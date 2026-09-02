import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STRATZ_API_TOKEN, STRATZ_BASE_URL } from "./config.js";
import { currentTrace, logUpstream } from "./telemetry.js";

/**
 * STRATZ GraphQL provider (https://api.stratz.com — free API, token required,
 * get one at https://stratz.com/api). Provides the rank-bracket / position
 * split aggregates that OpenDota's public endpoints no longer filter by.
 * Enabled only when STRATZ_API_TOKEN is set; every OpenDota tool keeps working
 * without it.
 */

export const STRATZ_ENABLED = STRATZ_API_TOKEN.length > 0;

const DISK_DIR = path.join(os.tmpdir(), "opendota-mcp-cache", "stratz");
const DISK_VERSION = 1;

interface CacheEntry {
  v: number;
  expiresAt: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

function diskFile(key: string): string {
  return path.join(DISK_DIR, `${createHash("sha1").update(key).digest("hex")}.json`);
}

function readDisk(key: string): CacheEntry | undefined {
  try {
    const file = diskFile(key);
    if (!existsSync(file)) return undefined;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return entry.v === DISK_VERSION && entry.expiresAt > Date.now() ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeDisk(key: string, entry: CacheEntry): void {
  try {
    mkdirSync(DISK_DIR, { recursive: true });
    writeFileSync(diskFile(key), JSON.stringify({ ...entry, v: DISK_VERSION }));
  } catch {
    /* best-effort */
  }
}

/** STRATZ rate limits are per second/minute/hour/day; serialize with a small gap well under any tier. */
let nextSlotAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 300;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export class StratzApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StratzApiError";
  }
}

export interface StratzQueryOptions {
  /** Cache lifetime (default 30 min — aggregates move slowly). */
  ttlMs?: number;
  timeoutMs?: number;
  /** Skip the cache read (still writes the fresh result). */
  noCache?: boolean;
}

/**
 * Run one GraphQL document against the STRATZ API with caching, throttling,
 * telemetry and friendly error normalization. `label` names the operation in
 * logs and error messages (e.g. "heroVsHeroMatchup").
 */
export async function stratzQuery<T = unknown>(label: string, query: string, options: StratzQueryOptions = {}): Promise<T> {
  const cacheKey = `GQL ${label} ${query}`;
  if (!options.noCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.data as T;
    const diskHit = readDisk(cacheKey);
    if (diskHit) {
      cache.set(cacheKey, diskHit);
      return diskHit.data as T;
    }
  }

  const trace = currentTrace();
  const startedAt = Date.now();
  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let data: unknown;
  try {
    const res = await fetch(STRATZ_BASE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${STRATZ_API_TOKEN}`,
        "User-Agent": "opendota-mcp (github.com/yuxiang115/opendota-mcp)",
      },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new StratzApiError(
        `STRATZ rejected the token (HTTP ${res.status}). Get a fresh token at https://stratz.com/api and set STRATZ_API_TOKEN.`,
        res.status,
      );
    }
    if (res.status === 429) {
      throw new StratzApiError("STRATZ rate limit hit (HTTP 429). Wait a moment and retry.", 429);
    }
    if (!res.ok) {
      throw new StratzApiError(`STRATZ API error HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    let body: { data?: unknown; errors?: { message: string }[] };
    try {
      body = JSON.parse(text);
    } catch {
      throw new StratzApiError(`STRATZ returned invalid JSON for ${label}`, 502);
    }
    if (body.errors?.length) {
      throw new StratzApiError(`STRATZ query error (${label}): ${body.errors[0].message}`, 400);
    }
    data = body.data;
    logUpstream({
      trace_id: trace.trace_id,
      tool: trace.tool,
      method: "POST",
      path: `stratz:${label}`,
      status: res.status,
      duration_ms: Date.now() - startedAt,
      cache: options.noCache ? "bypass" : "miss",
    });
  } catch (err) {
    logUpstream({
      trace_id: trace.trace_id,
      tool: trace.tool,
      method: "POST",
      path: `stratz:${label}`,
      duration_ms: Date.now() - startedAt,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    if (err instanceof StratzApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new StratzApiError(`STRATZ request timed out for ${label}`, 504);
    }
    throw new StratzApiError(`Network error calling STRATZ (${err instanceof Error ? err.message : String(err)})`, 502);
  } finally {
    clearTimeout(timeout);
  }

  const entry: CacheEntry = { v: DISK_VERSION, expiresAt: Date.now() + (options.ttlMs ?? 30 * 60_000), data };
  cache.set(cacheKey, entry);
  writeDisk(cacheKey, entry);
  return data as T;
}

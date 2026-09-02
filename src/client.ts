import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CACHE_TTL, OPENDEOTA_API_KEY, OPENDOTA_BASE_URL, RATE_LIMIT_PER_MINUTE } from "./config.js";

interface CacheEntry {
  expiresAt: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();

/** Concurrent identical GETs share a single upstream request (constants are hit once per row otherwise). */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Game constants are stable for hours but expensive to re-fetch on every process
 * start, so persist them under the OS tmpdir and reuse across restarts.
 */
const DISK_DIR = path.join(os.tmpdir(), "opendota-mcp-cache");

function diskFile(cacheKey: string): string {
  // Hash so the api_key possibly embedded in the URL never reaches the filesystem in plaintext.
  return path.join(DISK_DIR, `${createHash("sha1").update(cacheKey).digest("hex")}.json`);
}

function readDiskCache(cacheKey: string): CacheEntry | undefined {
  try {
    const file = diskFile(cacheKey);
    if (!existsSync(file)) return undefined;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return entry?.expiresAt > Date.now() ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeDiskCache(cacheKey: string, entry: CacheEntry): void {
  try {
    mkdirSync(DISK_DIR, { recursive: true });
    writeFileSync(diskFile(cacheKey), JSON.stringify(entry));
  } catch {
    /* disk cache is best-effort */
  }
}

interface RateLimiterOptions {
  limitPerMinute: number;
}

/** Simple token-bucket limiter so we stay under OpenDota's per-minute quota. */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly options: RateLimiterOptions) {}

  private prune(now: number): void {
    const cutoff = now - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      this.prune(now);
      if (this.timestamps.length < this.options.limitPerMinute) {
        this.timestamps.push(now);
        return;
      }
      // Wait until the oldest timestamp leaves the window, then retry.
      const waitMs = Math.min(this.timestamps[0] + 60_000 - now + 10, 20_000);
      if (attempt > 5) {
        throw new Error(
          `OpenDota rate limit reached (${this.options.limitPerMinute}/min). ` +
            "Set OPENDOTA_API_KEY for a higher limit, or retry in a minute.",
        );
      }
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
    }
  }
}

const limiter = new RateLimiter({ limitPerMinute: RATE_LIMIT_PER_MINUTE });

export class OpenDotaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "OpenDotaApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined | (string | number)[]>;
  /** Bypass the response cache for this call. */
  noCache?: boolean;
  /** Override cache TTL category. */
  ttl?: keyof typeof CACHE_TTL;
  /** Extra rate cost (e.g. POST /request/{match_id} counts as 10 calls). */
  rateCost?: number;
  /** Return the parsed body even on non-2xx status (e.g. /health reports status via HTTP 500). */
  allowErrorStatus?: boolean;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${OPENDOTA_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  if (OPENDEOTA_API_KEY) {
    url.searchParams.set("api_key", OPENDEOTA_API_KEY);
  }
  return url.toString();
}

function ttlMs(ttl?: keyof typeof CACHE_TTL): number {
  return CACHE_TTL[ttl ?? "default"];
}

/** Core request helper: cache + rate limit + error normalization. */
export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const url = buildUrl(path, options.query);
  const cacheKey = `${method} ${url}`;

  if (method === "GET" && !options.noCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.data as T;
    }
    if (options.ttl === "constants") {
      const diskHit = readDiskCache(cacheKey);
      if (diskHit) {
        cache.set(cacheKey, diskHit);
        return diskHit.data as T;
      }
    }
    const pending = inflight.get(cacheKey);
    if (pending) return pending as Promise<T>;
  }

  const cost = options.rateCost ?? 1;
  const request = (async (): Promise<T> => {
    for (let i = 0; i < cost; i++) {
      await limiter.acquire();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (res.status === 429) {
        throw new OpenDotaApiError(
          "OpenDota rate limit exceeded (HTTP 429). Wait a moment and retry, or configure OPENDOTA_API_KEY.",
          429,
          url,
        );
      }
      if (!res.ok && !options.allowErrorStatus) {
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignore body read errors */
        }
        throw new OpenDotaApiError(
          `OpenDota API error HTTP ${res.status} for ${path}${detail ? `: ${detail}` : ""}`,
          res.status,
          url,
        );
      }
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new OpenDotaApiError(`OpenDota returned invalid JSON for ${path}`, 502, url);
      }
      if (method === "GET") {
        const entry: CacheEntry = { expiresAt: Date.now() + ttlMs(options.ttl), data };
        cache.set(cacheKey, entry);
        if (options.ttl === "constants") writeDiskCache(cacheKey, entry);
      }
      return data as T;
    } catch (err) {
      if (err instanceof OpenDotaApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new OpenDotaApiError(`OpenDota request timed out for ${path}`, 504, url);
      }
      throw new OpenDotaApiError(
        `Network error calling OpenDota (${err instanceof Error ? err.message : String(err)})`,
        502,
        url,
      );
    } finally {
      clearTimeout(timeout);
    }
  })();

  if (method === "GET" && !options.noCache) {
    inflight.set(cacheKey, request);
    request.finally(() => inflight.delete(cacheKey)).catch(() => {});
  }
  return request;
}

export function clearCache(): void {
  cache.clear();
}

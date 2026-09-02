import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_TTL, OPENDEOTA_API_KEY, OPENDOTA_BASE_URL, RATE_LIMIT_PER_MINUTE, shouldSeedBundle } from "./config.js";

interface CacheEntry {
  /** Disk format version: old entries with a different TTL policy are ignored. */
  v?: number;
  expiresAt: number;
  data: unknown;
}

const DISK_CACHE_VERSION = 3;

const cache = new Map<string, CacheEntry>();

/** Concurrent identical GETs share a single upstream request (constants are hit once per row otherwise). */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Game constants are stable for hours but expensive to re-fetch on every process
 * start, so persist them under the OS tmpdir and reuse across restarts.
 */
const DISK_DIR = path.join(os.tmpdir(), "opendota-mcp-cache");

/** Shipped static constants seed (see scripts/build-data.ts); the runtime patch probe decides whether to also refresh from the API. */
const BUNDLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../constants-bundle",
);

export interface BundleManifest {
  bundled_at?: string;
  max_patch_id?: number;
  resources?: string[];
}

export function readBundleManifest(): BundleManifest | undefined {
  try {
    const file = path.join(BUNDLE_DIR, "manifest.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as BundleManifest;
  } catch {
    return undefined;
  }
}

/**
 * Seed the constants cache from the shipped bundle: each resource is written
 * into memory + disk cache (1h TTL, so SWR keeps refreshing it hourly).
 * Keys are computed with the current base URL/api key, so custom instances
 * only pick up seeds when explicitly enabled. Returns the seeded resource names.
 */
export function seedConstantsFromBundle(): string[] {
  const manifest = readBundleManifest();
  if (!manifest?.resources) return [];
  const seeded: string[] = [];
  for (const resource of manifest.resources) {
    try {
      const file = path.join(BUNDLE_DIR, `${resource}.json`);
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      const cacheKey = `GET ${buildUrl(`/constants/${resource}`, {})}`;
      const entry: CacheEntry = { expiresAt: Date.now() + CACHE_TTL.constants, data };
      cache.set(cacheKey, entry);
      writeDiskCache(cacheKey, entry);
      seeded.push(resource);
    } catch {
      /* skip unreadable resource */
    }
  }
  return seeded;
}

/** Resources force-refreshed after an id miss; at most once per process per resource. */
const healedResources = new Set<string>();

/** Negative-lookup self-heal: an unknown hero/item id means our constants may be stale — refresh that resource once. */
export function healResource(pathname: string): void {
  if (healedResources.has(pathname)) return;
  healedResources.add(pathname);
  apiGet(pathname, { ttl: "constants", forceRefresh: true }).catch(() => {});
}

let bundlePersistEnabled: boolean | null = null;

function persistAllowed(): boolean {
  if (bundlePersistEnabled === null) {
    const flag = (process.env.OPENDOTA_BUNDLE_PERSIST ?? "auto").toLowerCase();
    bundlePersistEnabled =
      flag === "1" || flag === "true" || flag === "on"
        ? true
        : flag === "0" || flag === "false" || flag === "off"
          ? false
          : shouldSeedBundle();
  }
  return bundlePersistEnabled;
}

const CONSTANTS_PATH_RE = /^\/constants\/([a-z_]+)$/;

/**
 * Write a freshly fetched constants resource back into the shipped bundle and
 * bump the manifest (so the next boot's patch probe compares against the new
 * data instead of the stale build). Entirely best-effort: npx caches and
 * read-only installs silently keep the original bundle, and runtime data
 * freshness never depends on this succeeding.
 */
function maybePersistToBundle(pathname: string, data: unknown): void {
  const match = CONSTANTS_PATH_RE.exec(pathname);
  if (!match || !persistAllowed()) return;
  const resource = match[1];
  if (Array.isArray(readBundleManifest()?.resources) && !(readBundleManifest()?.resources ?? []).includes(resource)) {
    return; // not part of the bundle — nothing to update
  }
  try {
    writeFileSync(path.join(BUNDLE_DIR, `${resource}.json`), JSON.stringify(data), "utf8");
    const manifest = readBundleManifest() ?? { resources: [] };
    const next: BundleManifest = { ...manifest, bundled_at: new Date().toISOString() };
    if (resource === "patch" && Array.isArray(data)) {
      next.max_patch_id = (data as { id?: number }[]).reduce((max, p) => Math.max(max, p.id ?? 0), 0);
    }
    writeFileSync(path.join(BUNDLE_DIR, "manifest.json"), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* read-only install (npx cache, system dir) — keep the shipped bundle */
  }
}

function diskFile(cacheKey: string): string {
  // Hash so the api_key possibly embedded in the URL never reaches the filesystem in plaintext.
  return path.join(DISK_DIR, `${createHash("sha1").update(cacheKey).digest("hex")}.json`);
}

function readDiskCache(cacheKey: string): CacheEntry | undefined {
  try {
    const file = diskFile(cacheKey);
    if (!existsSync(file)) return undefined;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (entry.v !== DISK_CACHE_VERSION) return undefined;
    return entry.expiresAt > Date.now() ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Like readDiskCache but returns the entry regardless of age (for stale-while-revalidate). */
function readDiskCacheAny(cacheKey: string): CacheEntry | undefined {
  try {
    const file = diskFile(cacheKey);
    if (!existsSync(file)) return undefined;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (entry.v !== DISK_CACHE_VERSION) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

function writeDiskCache(cacheKey: string, entry: CacheEntry): void {
  try {
    mkdirSync(DISK_DIR, { recursive: true });
    writeFileSync(diskFile(cacheKey), JSON.stringify({ ...entry, v: DISK_CACHE_VERSION }));
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
  /** Internal: bypass cache reads (used by the stale-while-revalidate background refresh). */
  forceRefresh?: boolean;
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

  if (method === "GET" && !options.noCache && !options.forceRefresh) {
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
      // Stale-while-revalidate: constants change rarely, so serve any-age entry
      // instantly and refresh in the background (rate-limited to one per key).
      triggerBackgroundRefresh(path, options);
      const stale = hit ?? readDiskCacheAny(cacheKey);
      if (stale) {
        return stale.data as T;
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
        if (options.ttl === "constants") {
          writeDiskCache(cacheKey, entry);
          // Self-updating bundle: a successful network fetch of a constants
          // resource is written back into the shipped bundle so the NEXT cold
          // start seeds fresh data (best-effort; read-only installs just skip).
          maybePersistToBundle(path, data);
        }
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

/** Fire a cache-bypassing refresh for a stale constants key (no-op if one is already running). */
function triggerBackgroundRefresh(path: string, options: RequestOptions): void {
  const url = buildUrl(path, options.query);
  const key = `${options.method ?? "GET"} ${url}`;
  if (inflight.has(key)) return;
  apiGet(path, { ...options, forceRefresh: true }).catch(() => {
    /* keep serving stale data on refresh failure */
  });
}

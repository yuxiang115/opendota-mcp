import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolves to <project>/locales both when running from src (tsx) and from dist/ after build.
export const LOCALES_DIR = path.resolve(__dirname, "../locales");

export const DEFAULT_LANGUAGE = process.env.OPENDOTA_LANGUAGE ?? "english";

export const OPENDEOTA_API_KEY = process.env.OPENDOTA_API_KEY ?? "";

/**
 * STRATZ GraphQL provider (bracket/position-split hero aggregates).
 * Free API, token required — get one at https://stratz.com/api (Steam login).
 * Empty by default: STRATZ tools only register when a token is configured.
 */
export const STRATZ_API_TOKEN = process.env.STRATZ_API_TOKEN?.trim() ?? "";

export const STRATZ_BASE_URL =
  process.env.STRATZ_BASE_URL ?? "https://api.stratz.com/graphql";

export const OPENDOTA_BASE_URL =
  process.env.OPENDOTA_BASE_URL ?? "https://api.opendota.com/api";

const DEFAULT_BASE_URL = "https://api.opendota.com/api";

/**
 * Whether the shipped constants bundle seeds the cache at boot.
 * "auto" (default): only when targeting the default OpenDota API — custom
 * instances may serve different data, so they keep fetching from their source.
 * "1"/"0" force the behavior on/off (used by tests).
 */
export function shouldSeedBundle(): boolean {
  const flag = (process.env.OPENDOTA_BUNDLE_SEED ?? "auto").toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") return true;
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return OPENDOTA_BASE_URL === DEFAULT_BASE_URL;
}

/** Requests per minute allowed by the OpenDota API (free tier: 60). We keep a small safety margin. */
export const RATE_LIMIT_PER_MINUTE = Number(
  process.env.OPENDOTA_RATE_LIMIT ?? (OPENDEOTA_API_KEY ? 1200 : 55),
);

/** Cache TTLs in milliseconds. Each tier matches how fast that endpoint class changes. */
export const CACHE_TTL = {
  /**
   * Game constants (heroes/items/abilities/enums). Refreshed at most once per hour
   * via stale-while-revalidate; tune with OPENDOTA_CONSTANTS_TTL_MINUTES.
   */
  constants: Number(process.env.OPENDOTA_CONSTANTS_TTL_MINUTES ?? 60) * 60 * 1000,
  /**
   * PARSED match records: replay analysis is immutable (only a rare re-parse
   * changes it), so these cache essentially forever. Tune with
   * OPENDOTA_PARSED_MATCH_TTL_HOURS (default 168 = one week).
   */
  matchParsed: Number(process.env.OPENDOTA_PARSED_MATCH_TTL_HOURS ?? 168) * 60 * 60 * 1000,
  /**
   * UNPARSED match records: the parse can land at any moment, so keep the
   * short window. Once a fetch returns a parsed record the entry upgrades to
   * matchParsed automatically.
   */
  match: 10 * 60 * 1000,
  /**
   * Slow player/profile endpoints (peers, hero pool, totals, ratings...):
   * these accumulate over days.
   */
  player: 60 * 60 * 1000,
  /**
   * Aggregated statistics (heroStats, matchups, scenario tables, explorer SQL
   * over a 180-day window): they move on a daily cadence.
   */
  aggregate: 6 * 60 * 60 * 1000,
  /** Rapidly changing listings (recent matches, live feeds). */
  listing: 60 * 1000,
  /** Default TTL for uncategorized GETs. */
  default: 5 * 60 * 1000,
} as const;

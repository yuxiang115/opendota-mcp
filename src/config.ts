import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolves to <project>/locales both when running from src (tsx) and from dist/ after build.
export const LOCALES_DIR = path.resolve(__dirname, "../locales");

export const DEFAULT_LANGUAGE = process.env.OPENDOTA_LANGUAGE ?? "english";

export const OPENDEOTA_API_KEY = process.env.OPENDOTA_API_KEY ?? "";

export const OPENDOTA_BASE_URL =
  process.env.OPENDOTA_BASE_URL ?? "https://api.opendota.com/api";

/** Requests per minute allowed by the OpenDota API (free tier: 60). We keep a small safety margin. */
export const RATE_LIMIT_PER_MINUTE = Number(
  process.env.OPENDOTA_RATE_LIMIT ?? (OPENDEOTA_API_KEY ? 1200 : 55),
);

/** Cache TTLs in milliseconds. */
export const CACHE_TTL = {
  /**
   * Game constants (heroes/items/abilities/enums). Refreshed at most once per hour
   * via stale-while-revalidate; tune with OPENDOTA_CONSTANTS_TTL_MINUTES.
   */
  constants: Number(process.env.OPENDOTA_CONSTANTS_TTL_MINUTES ?? 60) * 60 * 1000,
  /** Match records: immutable once parsed, but allow refresh window. */
  match: 10 * 60 * 1000,
  /** Rapidly changing listings. */
  listing: 60 * 1000,
  /** Default TTL for uncategorized GETs. */
  default: 5 * 60 * 1000,
} as const;

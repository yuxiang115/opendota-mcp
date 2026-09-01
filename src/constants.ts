import { apiGet } from "./client.js";

/**
 * Loaders for OpenDota's static-ish game constants.
 * These are cached for a long time (see CACHE_TTL.constants).
 */

export interface HeroConstant {
  id: number;
  name: string;
  localized_name: string;
  primary_attr: string;
  attack_type: string;
  roles: string[];
  img?: string;
  icon?: string;
  legs?: number;
  [key: string]: unknown;
}

export interface ItemConstant {
  dname?: string;
  cost?: number;
  img?: string;
  [key: string]: unknown;
}

export interface AbilityConstant {
  dname?: string;
  hurl?: string;
  [key: string]: unknown;
}

export interface PatchConstant {
  id?: number;
  name: string;
  [key: string]: unknown;
}

export interface NamedIdConstant {
  id: number;
  name: string;
  [key: string]: unknown;
}

export function getHeroes(): Promise<Record<string, HeroConstant>> {
  return apiGet<Record<string, HeroConstant>>("/constants/heroes", { ttl: "constants" });
}

export function getItems(): Promise<Record<string, ItemConstant>> {
  return apiGet<Record<string, ItemConstant>>("/constants/items", { ttl: "constants" });
}

export function getItemIds(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>("/constants/item_ids", { ttl: "constants" });
}

export function getAbilities(): Promise<Record<string, AbilityConstant>> {
  return apiGet<Record<string, AbilityConstant>>("/constants/abilities", { ttl: "constants" });
}

export function getAbilityIds(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>("/constants/ability_ids", { ttl: "constants" });
}

export function getGameModes(): Promise<Record<string, NamedIdConstant>> {
  return apiGet<Record<string, NamedIdConstant>>("/constants/game_mode", { ttl: "constants" });
}

export function getLobbyTypes(): Promise<Record<string, NamedIdConstant>> {
  return apiGet<Record<string, NamedIdConstant>>("/constants/lobby_type", { ttl: "constants" });
}

export function getRegions(): Promise<Record<string, NamedIdConstant>> {
  return apiGet<Record<string, NamedIdConstant>>("/constants/region", { ttl: "constants" });
}

export function getPatches(): Promise<PatchConstant[]> {
  return apiGet<PatchConstant[]>("/constants/patch", { ttl: "constants" });
}

/** Enum-ish constants that OpenDota does not expose; hardcoded per game semantics. */
export const SKILL_LABELS: Record<number, string> = {
  1: "Normal Skill",
  2: "High Skill",
  3: "Very High Skill",
};

export const LANE_ROLE_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Safe Lane (Pos 1)",
  2: "Mid Lane (Pos 2)",
  3: "Off Lane (Pos 3)",
  4: "Jungle",
};

export const LEAVER_STATUS_LABELS: Record<number, string> = {
  0: "None (played)",
  1: "Left Safely (safe to leave)",
  2: "Abandoned (safe to leave)",
  3: "Abandoned (not safe to leave)",
  4: "AfK (abandoned)",
  5: "Never Connected",
  6: "Never Connected (abandoned)",
  7: "Failed to Ready Up",
  8: "Declined",
};

const RANK_MEDALS = [
  "Unknown",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
];

export function rankTierToLabel(rankTier?: number, leaderboardRank?: number | null): string | undefined {
  if (rankTier == null || rankTier <= 0) return undefined;
  const medal = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  const medalName = RANK_MEDALS[medal] ?? `Rank ${medal}`;
  if (medal >= 8) {
    if (leaderboardRank != null && leaderboardRank > 0 && leaderboardRank <= 500) {
      return `Immortal (leaderboard #${leaderboardRank})`;
    }
    return "Immortal";
  }
  return stars > 0 ? `${medalName} ${stars}` : medalName;
}

/** Get the name for an arbitrary constant resource (passthrough). */
export function getConstantResource(resource: string): Promise<unknown> {
  return apiGet<unknown>(`/constants/${encodeURIComponent(resource)}`, { ttl: "constants" });
}

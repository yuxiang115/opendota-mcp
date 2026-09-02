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
  1: "Safe",
  2: "Mid",
  3: "Off",
  4: "Jungle",
};

/** Absolute lanes — labels from OpenDota's official frontend i18n (lane_pos_*). */
export const LANE_LABELS: Record<number, string> = {
  1: "Bot",
  2: "Mid",
  3: "Top",
  4: "Radiant Jungle",
  5: "Dire Jungle",
};

/** Leaver statuses — labels from OpenDota's official frontend i18n. */
export const LEAVER_STATUS_LABELS: Record<number, string> = {
  0: "None",
  1: "Left Safely",
  2: "Abandoned (DC)",
  3: "Abandoned",
  4: "Abandoned (AFK)",
  5: "Never Connected",
  6: "Never Connected (Timeout)",
};

/** Gold income sources — labels from OpenDota's official frontend i18n (gold_reasons_*). */
export const GOLD_REASON_LABELS: Record<number, string> = {
  0: "Other",
  1: "Death",
  2: "Buyback",
  11: "Building",
  12: "Hero",
  13: "Creep",
  14: "Neutrals",
  15: "Roshan",
  17: "Bounty Rune",
  20: "Ward",
};

/** XP sources — labels from OpenDota's official frontend i18n (xp_reasons_*). */
export const XP_REASON_LABELS: Record<number, string> = {
  0: "Other",
  1: "Hero",
  2: "Creep",
  3: "Roshan",
};

/** Runes — labels from OpenDota's official frontend i18n (rune_*). */
export const RUNE_LABELS: Record<number, string> = {
  0: "Double Damage",
  1: "Haste",
  2: "Illusion",
  3: "Invisibility",
  4: "Regeneration",
  5: "Bounty",
  6: "Arcane",
  7: "Water",
  8: "Wisdom",
  9: "Shield",
};

/** Kill streak lengths — Valve in-game announcer strings (not API-documented). */
export const KILL_STREAK_LABELS: Record<number, string> = {
  3: "Killing Spree",
  4: "Dominating",
  5: "Mega Kill",
  6: "Unstoppable",
  7: "Wicked Sick",
  8: "Monster Kill",
  9: "Godlike",
  10: "Beyond Godlike",
};

/** Multi-kill sizes — Valve in-game announcer strings (not API-documented). */
export const MULTI_KILL_LABELS: Record<number, string> = {
  2: "Double Kill",
  3: "Triple Kill",
  4: "Ultra Kill",
  5: "Rampage",
};

/** Match objective event types seen in parsed replays (odota/web MatchStory). */
export const OBJECTIVE_LABELS: Record<string, string> = {
  CHAT_MESSAGE_FIRSTBLOOD: "First Blood",
  CHAT_MESSAGE_ROSHAN_KILL: "Roshan Kill",
  CHAT_MESSAGE_TOWER_KILL: "Tower Kill",
  CHAT_MESSAGE_TOWER_DENY: "Tower Deny",
  CHAT_MESSAGE_BARRACKS_KILL: "Barracks Kill",
  CHAT_MESSAGE_AEGIS: "Aegis Picked Up",
  CHAT_MESSAGE_AEGIS_STOLEN: "Aegis Stolen",
  CHAT_MESSAGE_DENIED_AEGIS: "Aegis Denied",
  CHAT_MESSAGE_COURIER_LOST: "Courier Lost",
  building_kill: "Building Kill",
  chat: "Chat",
};

/** Label a gold/xp reason key, keeping the raw key visible when undocumented. */
export function labelEnumKey(labels: Record<number, string>, key: string | number): string {
  const n = Number(key);
  return labels[n] ?? `reason_${key}`;
}

/** Relabel every key of a {enumKey: count} map, sorted by count descending. */
export function labelEnumKeyMap(
  labels: Record<number, string>,
  map: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!map) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map).sort((a, b) => b[1] - a[1])) {
    out[labelEnumKey(labels, k)] = v;
  }
  return out;
}

/**
 * Decode a tower_status bitmask. Bit layout per Valve's GetMatchDetails docs:
 * 0-2 top T1/T2/T3, 3-5 mid T1/T2/T3, 6-8 bottom T1/T2/T3, 9-10 ancient top/bottom.
 * A set bit means the tower is still standing (spec: 2047 = everything alive).
 */
export function decodeTowerStatus(mask: number | undefined | null): Record<string, boolean> | undefined {
  if (mask == null) return undefined;
  const names = [
    "top_t1", "top_t2", "top_t3",
    "mid_t1", "mid_t2", "mid_t3",
    "bot_t1", "bot_t2", "bot_t3",
    "ancient_top", "ancient_bottom",
  ];
  const out: Record<string, boolean> = {};
  names.forEach((n, i) => (out[n] = ((mask >> i) & 1) === 1));
  out.all_standing = mask === 2047;
  return out;
}

/**
 * Decode a barracks_status bitmask. Bits per Valve docs:
 * 0-1 top melee/ranged, 2-3 mid melee/ranged, 4-5 bottom melee/ranged.
 */
export function decodeBarracksStatus(mask: number | undefined | null): Record<string, boolean> | undefined {
  if (mask == null) return undefined;
  const names = ["top_melee", "top_ranged", "mid_melee", "mid_ranged", "bot_melee", "bot_ranged"];
  const out: Record<string, boolean> = {};
  names.forEach((n, i) => (out[n] = ((mask >> i) & 1) === 1));
  out.all_standing = mask === 63;
  return out;
}

const RANK_MEDALS = [
  "Uncalibrated",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
];

/**
 * Official medal tier names from Valve's client localization tokens
 * (DOTARankTierName0-8, dota_{language}.txt). Subset: languages players most
 * often ask for; other languages fall back to English names.
 */
const RANK_MEDALS_I18N: Record<string, string[]> = {
  schinese: ["未校准", "先锋", "卫士", "中军", "统帅", "传奇", "万古流芳", "超凡入圣", "冠绝一世"],
  tchinese: ["未校準", "先鋒", "守護者", "十字軍", "執政官", "傳奇", "萬古流芳", "超凡入聖", "永垂不朽"],
};

function rankMedalName(medal: number, lang?: string): string {
  const table = RANK_MEDALS_I18N[String(lang ?? "english")] ?? RANK_MEDALS;
  return table[medal] ?? RANK_MEDALS[medal] ?? `Rank ${medal}`;
}

export function rankTierToLabel(rankTier?: number, leaderboardRank?: number | null, lang?: string): string | undefined {
  if (rankTier == null) return undefined;
  if (rankTier === 0) return rankMedalName(0, lang);
  const medal = Math.floor(rankTier / 10);
  const stars = rankTier % 10;
  if (medal >= 8) {
    if (leaderboardRank != null && leaderboardRank > 0 && leaderboardRank <= 500) {
      return `${rankMedalName(8, lang)} (leaderboard #${leaderboardRank})`;
    }
    return rankMedalName(8, lang);
  }
  const medalName = rankMedalName(medal, lang);
  return stars > 0 ? `${medalName} ${stars}` : medalName;
}

/** Benchmark/heroStats bracket ids: 1 Herald .. 8 Immortal (OpenDota /benchmarks bracket param). */
export function bracketLabel(bracket?: number, lang?: string): string | undefined {
  if (bracket == null) return undefined;
  return rankMedalName(bracket, lang);
}

export function getOrderTypes(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>("/constants/order_types", { ttl: "constants" });
}

export function getPermanentBuffs(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>("/constants/permanent_buffs", { ttl: "constants" });
}

export interface HeroFacet {
  id: number;
  name: string;
  title?: string;
  description?: string;
  deprecated?: string;
}

/** Per-hero ability/facet tables from /constants/hero_abilities. */
export function getHeroAbilities(): Promise<Record<string, {
  abilities?: string[];
  talents?: { name: string; level?: number }[];
  facets?: HeroFacet[];
}>> {
  return apiGet<Record<string, {
    abilities?: string[];
    talents?: { name: string; level?: number }[];
    facets?: HeroFacet[];
  }>>("/constants/hero_abilities", { ttl: "constants" });
}

export interface ChatWheelEntry {
  id: number;
  name?: string;
  label?: string;
  message?: string;
  /** Whether the phrase is broadcast to all chat (vs allies-only) — odota/web Chat.tsx. */
  all_chat?: boolean;
  sound_ext?: string;
}

/** In-game chat wheel phrases (dotaconstants chat_wheel.json; also covers sprays/stickers keyspace partially). */
export function getChatWheel(): Promise<Record<string, ChatWheelEntry>> {
  return apiGet<Record<string, ChatWheelEntry>>("/constants/chat_wheel", { ttl: "constants" });
}

export interface CountryEntry {
  name?: { common?: string };
  cca2?: string;
}

export function getCountries(): Promise<Record<string, CountryEntry>> {
  return apiGet<Record<string, CountryEntry>>("/constants/countries", { ttl: "constants" });
}

/** All constant resources available via get_constants (mirrors the dotaconstants package file list). */
export const CONSTANTS_RESOURCES = [
  "abilities", "ability_ids", "aghs_desc", "ancients", "chat_wheel", "cluster", "countries",
  "game_mode", "hero_abilities", "hero_lore", "heroes", "item_colors", "item_ids", "items",
  "lobby_type", "neutral_abilities", "order_types", "patch", "patchnotes", "permanent_buffs",
  "player_colors", "region", "skillshots", "xp_level",
] as const;

/** Get the name for an arbitrary constant resource (passthrough). */
export function getConstantResource(resource: string): Promise<unknown> {
  return apiGet<unknown>(`/constants/${encodeURIComponent(resource)}`, { ttl: "constants" });
}

import { getLocaleBundle, type SupportedLanguage } from "./locales.js";
import {
  getAbilityIds,
  getAbilities,
  getGameModes,
  getHeroes,
  getItemIds,
  getItems,
  getLobbyTypes,
  getPatches,
  getRegions,
  LANE_ROLE_LABELS,
  LEAVER_STATUS_LABELS,
  rankTierToLabel,
  SKILL_LABELS,
} from "./constants.js";

/** A resolvable game-entity reference: numeric id + localized name + English name. */
export interface NameRef {
  id?: number;
  name: string;
  name_en: string;
}

/** Resolve a hero id to a localized reference. */
export async function heroRef(heroId: number | undefined | null, lang: SupportedLanguage): Promise<NameRef | undefined> {
  if (heroId == null || Number.isNaN(Number(heroId))) return undefined;
  const key = String(heroId);
  const local = getLocaleBundle(lang).heroes[key];
  const english = getLocaleBundle("english").heroes[key];
  let fallbackEn: string | undefined;
  try {
    fallbackEn = (await getHeroes())[key]?.localized_name;
  } catch {
    fallbackEn = undefined;
  }
  const name = local?.name ?? english?.name ?? fallbackEn ?? `hero ${heroId}`;
  const nameEn = english?.name ?? local?.name_en ?? fallbackEn ?? `hero ${heroId}`;
  return { id: Number(heroId), name, name_en: nameEn };
}

/** Resolve a numeric item id (e.g. 1 = Blink Dagger) to a localized reference. */
export async function itemRef(itemId: number | undefined | null, lang: SupportedLanguage): Promise<NameRef | undefined> {
  if (itemId == null || itemId === 0) return undefined;
  const key = String(itemId);
  const local = getLocaleBundle(lang).items[key];
  const english = getLocaleBundle("english").items[key];
  if (local || english) {
    return {
      id: Number(itemId),
      name: local?.name ?? english?.name ?? `item ${itemId}`,
      name_en: english?.name ?? local?.name_en ?? `item ${itemId}`,
    };
  }
  // Fall back to OpenDota constants (item_ids -> items).
  try {
    const internal = (await getItemIds())[key];
    if (!internal) return { id: Number(itemId), name: `item ${itemId}`, name_en: `item ${itemId}` };
    const dname = (await getItems())[internal]?.dname ?? internal;
    return { id: Number(itemId), name: dname, name_en: dname };
  } catch {
    return { id: Number(itemId), name: `item ${itemId}`, name_en: `item ${itemId}` };
  }
}

/** Resolve a numeric ability id to a localized reference. */
export async function abilityRef(
  abilityId: number | undefined | null,
  lang: SupportedLanguage,
): Promise<NameRef | undefined> {
  if (abilityId == null || abilityId === 0) return undefined;
  const key = String(abilityId);
  const local = getLocaleBundle(lang).abilities[key];
  const english = getLocaleBundle("english").abilities[key];
  if (local || english) {
    return {
      id: Number(abilityId),
      name: local?.name ?? english?.name ?? `ability ${abilityId}`,
      name_en: english?.name ?? local?.name_en ?? `ability ${abilityId}`,
    };
  }
  try {
    const internal = (await getAbilityIds())[key];
    if (!internal) return undefined;
    const dname = (await getAbilities())[internal]?.dname ?? internal;
    return { id: Number(abilityId), name: dname, name_en: dname };
  } catch {
    return undefined;
  }
}

export function formatDuration(seconds?: number | null): string | undefined {
  if (seconds == null) return undefined;
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatTimestamp(seconds?: number | null): string | undefined {
  if (seconds == null) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** player_slot < 128 means Radiant. */
export function sideFromPlayerSlot(playerSlot: number): "radiant" | "dire" {
  return playerSlot < 128 ? "radiant" : "dire";
}

/** Turn constant tokens like "game_mode_all_draft" into readable labels like "All Draft". */
function prettifyEnumName(raw: string): string {
  const stripped = raw.replace(/^(game_mode_|lobby_type_|cluster_|region_)/, "");
  return stripped
    .split(/[_\s]+/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export async function gameModeName(id?: number | null): Promise<string | undefined> {
  if (id == null) return undefined;
  try {
    const name = (await getGameModes())[String(id)]?.name;
    return name ? prettifyEnumName(name) : undefined;
  } catch {
    return undefined;
  }
}

export async function lobbyTypeName(id?: number | null): Promise<string | undefined> {
  if (id == null) return undefined;
  try {
    const name = (await getLobbyTypes())[String(id)]?.name;
    return name ? prettifyEnumName(name) : undefined;
  } catch {
    return undefined;
  }
}

export async function patchName(id?: number | null): Promise<string | undefined> {
  if (id == null) return undefined;
  try {
    const patches = await getPatches();
    const byId = new Map(patches.map((p) => [String(p.id), p.name]));
    return byId.get(String(id));
  } catch {
    return undefined;
  }
}

export async function regionName(regionId?: number | null): Promise<string | undefined> {
  if (regionId == null) return undefined;
  try {
    return (await getRegions())[String(regionId)]?.name;
  } catch {
    return undefined;
  }
}

export function skillLabel(skill?: number | null): string | undefined {
  if (skill == null) return undefined;
  return SKILL_LABELS[skill] ?? `Skill ${skill}`;
}

export function laneRoleLabel(laneRole?: number | null): string | undefined {
  if (laneRole == null) return undefined;
  return LANE_ROLE_LABELS[laneRole] ?? `Lane role ${laneRole}`;
}

export function leaverStatusLabel(status?: number | null): string | undefined {
  if (status == null) return undefined;
  return LEAVER_STATUS_LABELS[status] ?? `Leaver status ${status}`;
}

export function kdaRatio(kills: number, deaths: number, assists: number): number {
  const denom = deaths > 0 ? deaths : 1;
  return Math.round(((kills + assists) / denom) * 10) / 10;
}

export { rankTierToLabel };

/**
 * Enrich a row from player match listings (/players/{id}/matches, recentMatches, proMatches…).
 * Adds hero names, side, win flag, and human-readable mode/duration/time.
 */
export async function enrichPlayerMatchRow(
  row: Record<string, unknown>,
  lang: SupportedLanguage,
): Promise<Record<string, unknown>> {
  const hero = await heroRef(row.hero_id as number, lang);
  const radiantWin = row.radiant_win as boolean | undefined;
  const isRadiant = row.player_slot != null ? sideFromPlayerSlot(row.player_slot as number) === "radiant" : undefined;
  const win = radiantWin != null && isRadiant != null ? radiantWin === isRadiant : undefined;
  const out: Record<string, unknown> = { ...row };
  if (hero) out.hero = hero;
  delete out.hero_id;
  if (row.kills != null && row.deaths != null && row.assists != null) {
    out.kda = kdaRatio(row.kills as number, row.deaths as number, row.assists as number);
  }
  if (isRadiant != null) out.is_radiant = isRadiant;
  if (win != null) out.win = win;
  if (row.duration != null) out.duration = formatDuration(row.duration as number);
  if (row.start_time != null) out.start_time = formatTimestamp(row.start_time as number);
  const mode = await gameModeName(row.game_mode as number);
  if (mode) out.game_mode = mode;
  else if (row.game_mode == null) delete out.game_mode;
  else out.game_mode = `mode ${row.game_mode}`;
  const lobby = await lobbyTypeName(row.lobby_type as number);
  if (lobby) out.lobby_type = lobby;
  else if (row.lobby_type != null) out.lobby_type = `lobby ${row.lobby_type}`;
  const skill = skillLabel(row.skill as number);
  if (skill) out.skill = skill;
  const lane = laneRoleLabel(row.lane_role as number);
  if (lane) out.lane_role = lane;
  const leaver = leaverStatusLabel(row.leaver_status as number);
  if (leaver) out.leaver_status = leaver;
  const avgRank = row.average_rank as number | undefined;
  if (avgRank != null && avgRank > 0) {
    out.average_rank = rankTierToLabel(avgRank);
  }
  return out;
}

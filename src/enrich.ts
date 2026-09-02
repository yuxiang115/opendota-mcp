import type { SupportedLanguage } from "./locales.js";
import { getLocaleBundle } from "./locales.js";
import { getItems } from "./constants.js";
import {
  abilityRef,
  formatDuration,
  formatTimestamp,
  gameModeName,
  heroRef,
  itemRef,
  kdaRatio,
  laneRoleLabel,
  lobbyTypeName,
  regionName,
  rankTierToLabel,
  sideFromPlayerSlot,
  skillLabel,
  type NameRef,
} from "./mapping.js";

/** Reverse index: internal item name (e.g. "blink", "item_blink") -> numeric id. */
const itemInternalIndex = new Map<string, number>();

function ensureItemInternalIndex(): void {
  if (itemInternalIndex.size > 0) return;
  const english = getLocaleBundle("english").items;
  for (const [id, entry] of Object.entries(english)) {
    itemInternalIndex.set(entry.internal, Number(id));
    // Index both prefixed ("item_blink") and short ("blink") forms — purchase logs use the short form.
    itemInternalIndex.set(entry.internal.replace(/^item_/, ""), Number(id));
  }
}

/** Resolve an item referenced by internal name (used by /heroes/{id}/itemPopularity). */
export async function itemInternalRef(internal: string, lang: SupportedLanguage): Promise<NameRef | undefined> {
  ensureItemInternalIndex();
  const id = itemInternalIndex.get(internal) ?? itemInternalIndex.get(internal.replace(/^item_/, ""));
  if (id != null) return itemRef(id, lang);
  try {
    const dname = (await getItems())[internal]?.dname;
    if (dname) return { name: dname, name_en: dname };
  } catch {
    /* ignore */
  }
  return { name: internal, name_en: internal };
}

/** Item gold cost by internal key (short or prefixed form). */
async function itemCostByKey(key: string): Promise<number | undefined> {
  try {
    const items = await getItems();
    return items[key]?.cost ?? items[key.replace(/^item_/, "")]?.cost;
  } catch {
    return undefined;
  }
}

/** Reverse index: hero internal name ("npc_dota_hero_medusa") -> numeric id (kills_log victims). */
const heroInternalIndex = new Map<string, number>();

async function heroInternalRef(internal: string, lang: SupportedLanguage): Promise<NameRef> {
  if (heroInternalIndex.size === 0) {
    for (const [id, entry] of Object.entries(getLocaleBundle("english").heroes)) {
      heroInternalIndex.set(entry.internal, Number(id));
    }
  }
  const id = heroInternalIndex.get(internal);
  if (id != null) return (await heroRef(id, lang)) ?? { name: internal, name_en: internal };
  return { name: internal, name_en: internal };
}

/**
 * Absolute lane ids: 1=bottom, 2=middle, 3=top. Safe/off depends on the side
 * (Radiant safe lane is bottom, Dire's is top).
 */
function laneLabel(lane: number | undefined, isRadiant: boolean | undefined): string | undefined {
  if (lane == null) return undefined;
  if (lane === 2) return "middle";
  if (lane === 1) return isRadiant ? "bottom (safe side)" : "bottom (off side)";
  if (lane === 3) return isRadiant ? "top (off side)" : "top (safe side)";
  return `lane ${lane}`;
}

/**
 * Estimate Dota positions 1-5 per team from lane_role (1 safe / 2 mid / 3 off /
 * 4 jungle) plus within-lane farm order: the highest-farming player of each lane
 * group takes that lane's primary position (1/2/3), the rest fill 4/5 by farm.
 * Parsed matches sometimes carry role ("Core"/"Support"); when present it
 * reserves Support players for the 4/5 pool.
 */
function assignPositions(rawPlayers: Record<string, any>[]): (number | undefined)[] {
  const out: (number | undefined)[] = rawPlayers.map(() => undefined);
  for (const radiant of [true, false]) {
    const team = rawPlayers
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => sideFromPlayerSlot(p.player_slot ?? (radiant ? 0 : 128)) === (radiant ? "radiant" : "dire"));
    if (team.length === 0) continue;
    const farm = (x: { p: Record<string, any> }) => x.p.gold_per_min ?? x.p.net_worth ?? 0;
    const usedPos = new Set<number>();
    const unassigned = new Set(team.map((t) => t.i));
    const supports = new Set(
      team.filter(({ p }) => typeof p.role === "string" && /support/i.test(p.role)).map(({ i }) => i),
    );

    const mid = team.find(({ p }) => p.lane_role === 2);
    if (mid) {
      out[mid.i] = 2;
      usedPos.add(2);
      unassigned.delete(mid.i);
    }
    for (const lr of [1, 3]) {
      const group = team.filter(({ p, i }) => unassigned.has(i) && p.lane_role === lr && !supports.has(i));
      const fallback = group.length ? group : team.filter(({ p, i }) => unassigned.has(i) && p.lane_role === lr);
      if (fallback.length > 0 && !usedPos.has(lr)) {
        fallback.sort((a, b) => farm(b) - farm(a));
        out[fallback[0].i] = lr;
        usedPos.add(lr);
        unassigned.delete(fallback[0].i);
      }
    }
    const rest = team.filter(({ i }) => unassigned.has(i)).sort((a, b) => farm(b) - farm(a));
    const free = [1, 2, 3, 4, 5].filter((n) => !usedPos.has(n));
    rest.forEach((t, k) => {
      if (k < free.length) {
        out[t.i] = free[k];
        usedPos.add(free[k]);
      }
    });
  }
  return out;
}

async function mapValuesToRefs(
  record: Record<string, unknown> | undefined,
  lang: SupportedLanguage,
): Promise<Record<string, NameRef & { count?: number }> | undefined> {
  if (!record) return undefined;
  const out: Record<string, NameRef & { count?: number }> = {};
  for (const [key, value] of Object.entries(record)) {
    const ref = await itemInternalRef(key, lang);
    if (ref) out[ref.name] = { ...ref, count: value as number };
  }
  return out;
}

export interface MatchIncludeOptions {
  picks_bans?: boolean;
  teamfights?: boolean;
  objectives?: boolean;
  chat?: boolean;
  graphs?: boolean;
  draft_timings?: boolean;
  player_logs?: boolean;
  benchmarks?: boolean;
}

const ITEM_SLOTS = [0, 1, 2, 3, 4, 5] as const;
const BACKPACK_SLOTS = [0, 1, 2] as const;

interface RawPlayer {
  [key: string]: unknown;
}

async function enrichMatchPlayer(p: RawPlayer, lang: SupportedLanguage, includeLogs: boolean, includeBenchmarks: boolean) {
  const hero = await heroRef(p.hero_id as number, lang);
  const isRadiant = p.player_slot != null ? sideFromPlayerSlot(p.player_slot as number) === "radiant" : undefined;
  const radiantWin = p.radiant_win as boolean | undefined;
  const win = radiantWin != null && isRadiant != null ? radiantWin === isRadiant : undefined;

  const items: (NameRef & { slot: number })[] = [];
  for (const slot of ITEM_SLOTS) {
    const ref = await itemRef(p[`item_${slot}`] as number, lang);
    if (ref) items.push({ slot, ...ref });
  }
  const backpack: (NameRef & { slot: number })[] = [];
  for (const slot of BACKPACK_SLOTS) {
    const ref = await itemRef(p[`backpack_${slot}`] as number, lang);
    if (ref) backpack.push({ slot, ...ref });
  }
  const neutral = await itemRef(p.item_neutral as number, lang);

  let abilityBuild: NameRef[] | undefined;
  const upgradesRaw = (p.ability_upgrades_arr as number[] | undefined) ?? (p.ability_upgrades as { ability: number }[] | undefined);
  if (Array.isArray(upgradesRaw) && upgradesRaw.length > 0) {
    const ids = upgradesRaw.map((u) => (typeof u === "number" ? u : (u as { ability: number }).ability));
    abilityBuild = (await Promise.all(ids.map((id) => abilityRef(id, lang)))).filter(
      (r): r is NameRef => r != null,
    );
  }

  const kills = (p.kills as number) ?? 0;
  const deaths = (p.deaths as number) ?? 0;
  const assists = (p.assists as number) ?? 0;

  const out: Record<string, unknown> = {
    is_radiant: isRadiant,
    win,
    account_id: p.account_id,
    personaname: p.personaname,
    player_slot: p.player_slot,
    hero,
    kills,
    deaths,
    assists,
    kda: kdaRatio(kills, deaths, assists),
    level: p.level,
    net_worth: p.net_worth,
    last_hits: p.last_hits,
    denies: p.denies,
    gold_per_min: p.gold_per_min,
    xp_per_min: p.xp_per_min,
    hero_damage: p.hero_damage,
    hero_healing: p.hero_healing,
    tower_damage: p.tower_damage,
    lane: laneLabel(p.lane as number, isRadiant),
    lane_role: laneRoleLabel(p.lane_role as number),
    role: p.role,
    is_roaming: p.is_roaming ?? undefined,
    lane_efficiency_pct: p.lane_efficiency_pct,
    stuns: p.stuns,
    teamfight_participation: p.teamfight_participation,
    towers_killed: p.towers_killed,
    roshans_killed: p.roshans_killed,
    creeps_stacked: p.creeps_stacked,
    camps_stacked: p.camps_stacked,
    buyback_count: p.buyback_count,
    firstblood_claimed: p.firstblood_claimed,
    actions_per_min: p.actions_per_min,
    observer_purchases: p.purchase_ward_observer,
    sentry_purchases: p.purchase_ward_sentry,
    neutral_kills: p.neutral_kills,
    items,
    backpack,
    neutral_item: neutral,
    ability_build: abilityBuild,
    obs_placed: p.obs_placed,
    sen_placed: p.sen_placed,
  };
  if (p.rank_tier != null && (p.rank_tier as number) > 0) {
    out.rank_tier = rankTierToLabel(p.rank_tier as number);
  }
  if (includeBenchmarks && p.benchmarks != null) {
    out.benchmarks = p.benchmarks;
  }
  if (includeLogs) {
    out.purchase_log = await Promise.all(
      ((p.purchase_log ?? []) as { time: number; key: string }[]).map(async (e) => ({
        time: formatDuration(e.time),
        item: (await itemInternalRef(e.key, lang))?.name,
        cost: await itemCostByKey(e.key),
      })),
    );
    out.kills_log = await Promise.all(
      ((p.kills_log ?? []) as { time: number; key: string }[]).map(async (e) => ({
        time: formatDuration(e.time),
        victim: await heroInternalRef(e.key, lang),
      })),
    );
    const trimWardLog = (log: unknown) =>
      ((log ?? []) as { time?: number; x?: number; y?: number }[]).map((e) => ({
        time: formatDuration(e.time),
        x: e.x,
        y: e.y,
      }));
    out.obs_log = trimWardLog(p.obs_log);
    out.sen_log = trimWardLog(p.sen_log);
    out.runes = p.runes;
    out.item_uses = p.item_uses;
    out.ability_uses = p.ability_uses;
    out.damage_targets = p.damage ?? undefined;
  }
  // Strip undefined/null keys for compactness.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null) delete out[k];
  }
  return out;
}

/**
 * Transform a raw OpenDota match object into a compact, human/LLM-readable view:
 * all hero/item/ability ids resolved to localized names, enums to labels.
 */
export async function enrichMatch(
  match: Record<string, any>,
  lang: SupportedLanguage,
  include: MatchIncludeOptions = {},
): Promise<Record<string, unknown>> {
  const {
    picks_bans: includePicksBans = true,
    teamfights: includeTeamfights = false,
    objectives: includeObjectives = false,
    chat: includeChat = false,
    graphs: includeGraphs = false,
    draft_timings: includeDraftTimings = false,
    player_logs: includePlayerLogs = false,
    benchmarks: includeBenchmarks = false,
  } = include;

  const players = Array.isArray(match.players)
    ? await Promise.all(match.players.map((p: RawPlayer) => enrichMatchPlayer(p, lang, includePlayerLogs, includeBenchmarks)))
    : [];
  // Positions: prefer OpenDota's own position_est (behavior-based, available on parsed
  // matches); the lane+farm heuristic only fills players without a native estimate.
  const rawPlayers = (Array.isArray(match.players) ? match.players : []) as Record<string, any>[];
  const positions = assignPositions(rawPlayers);
  players.forEach((pl, i) => {
    const native = rawPlayers[i]?.position_est;
    pl.position =
      typeof native === "number" && native >= 1 && native <= 5 ? native : positions[i];
  });

  const out: Record<string, unknown> = {
    match_id: match.match_id,
    radiant_win: match.radiant_win,
    radiant_score: match.radiant_score,
    dire_score: match.dire_score,
    duration: formatDuration(match.duration),
    duration_seconds: match.duration,
    start_time: formatTimestamp(match.start_time),
    game_mode: (await gameModeName(match.game_mode)) ?? match.game_mode,
    lobby_type: (await lobbyTypeName(match.lobby_type)) ?? match.lobby_type,
    skill: skillLabel(match.skill),
    region: await regionName(match.cluster),
    first_blood_time: formatDuration(match.first_blood_time),
    league: match.league?.name ?? undefined,
    radiant_team_name: match.radiant_team?.team_name ?? match.radiant_team?.name ?? undefined,
    dire_team_name: match.dire_team?.team_name ?? match.dire_team?.name ?? undefined,
    series_type: match.series_type,
    radiant_series_wins: match.radiant_series_wins,
    dire_series_wins: match.dire_series_wins,
    players,
  };

  if (includePicksBans && Array.isArray(match.picks_bans)) {
    out.picks_bans = await Promise.all(
      match.picks_bans.map(async (pb: Record<string, any>) => ({
        order: pb.order,
        team: pb.team === 2 ? "radiant" : pb.team === 3 ? "dire" : pb.team,
        is_pick: pb.is_pick,
        hero: await heroRef(pb.hero_id, lang),
      })),
    );
  }
  if (includeTeamfights && Array.isArray(match.teamfights)) {
    out.teamfights = await Promise.all(
      match.teamfights.map(async (tf: Record<string, any>) => ({
        start: formatDuration(tf.start),
        end: formatDuration(tf.end),
        last_death: formatDuration(tf.last_death),
        deaths: tf.deaths,
        players: (tf.players ?? []).map((tp: any, i: number) => ({
          player_index: i,
          deaths: tp.deaths,
          damage: tp.damage,
          gold_delta: tp.gold_delta,
          xp_delta: tp.xp_delta,
          abilities_used: tp.abilities_used,
        })),
      })),
    );
  }
  if (includeObjectives && Array.isArray(match.objectives)) {
    out.objectives = match.objectives;
  }
  if (includeChat && Array.isArray(match.chat)) {
    out.chat = match.chat.map((c: any) => ({ ...c, time: formatDuration(c.time) }));
  }
  if (includeDraftTimings && Array.isArray(match.draft_timings)) {
    out.draft_timings = await Promise.all(
      match.draft_timings.map(async (d: any) => ({
        ...d,
        hero: await heroRef(d.hero_id, lang),
      })),
    );
  }
  if (includeGraphs) {
    out.radiant_gold_advantage_by_minute = match.radiant_gold_adv;
    out.radiant_xp_advantage_by_minute = match.radiant_xp_adv;
  }

  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null) delete out[k];
  }
  return out;
}

/** Enrich a hero/item popularity payload (keys are internal item names). */
export async function enrichItemPopularity(
  payload: Record<string, Record<string, number>>,
  lang: SupportedLanguage,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [phase, items] of Object.entries(payload)) {
    out[phase] = await mapValuesToRefs(items, lang);
  }
  return out;
}

/** Enrich heroStats rows: attach hero refs and readable pick/win rates. */
export async function enrichHeroStatRow(row: Record<string, any>, lang: SupportedLanguage): Promise<Record<string, unknown>> {
  const hero = await heroRef(row.hero_id ?? row.id, lang);
  const out: Record<string, unknown> = { ...row, hero };
  delete out.hero_id;
  delete out.id;
  const compute = (pickKey: string, winKey: string, label: string) => {
    const picks = row[pickKey] as number | undefined;
    const wins = row[winKey] as number | undefined;
    if (picks != null && wins != null && picks > 0) {
      out[label] = Math.round((wins / picks) * 1000) / 10;
    }
  };
  compute("pro_pick", "pro_win", "pro_win_rate_pct");
  compute("1_pick", "1_win", "herald_win_rate_pct");
  compute("2_pick", "2_win", "guardian_win_rate_pct");
  compute("3_pick", "3_win", "crusader_win_rate_pct");
  compute("4_pick", "4_win", "archon_win_rate_pct");
  compute("5_pick", "5_win", "legend_win_rate_pct");
  compute("6_pick", "6_win", "ancient_win_rate_pct");
  compute("7_pick", "7_win", "divine_win_rate_pct");
  compute("8_pick", "8_win", "immortal_win_rate_pct");
  compute("turbo_pick", "turbo_win", "turbo_win_rate_pct");
  return out;
}

/** Enrich hero matchup rows (hero_id, games_played, wins). */
export async function enrichHeroMatchupRow(row: Record<string, any>, lang: SupportedLanguage): Promise<Record<string, unknown>> {
  const hero = await heroRef(row.hero_id, lang);
  const games = row.games_played as number;
  const wins = row.wins as number;
  const out: Record<string, unknown> = { ...row };
  if (hero) out.hero = hero;
  delete out.hero_id;
  if (games > 0) {
    out.win_rate_pct = Math.round((wins / games) * 1000) / 10;
  }
  return out;
}

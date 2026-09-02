import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichMatch } from "../enrich.js";
import { getAbilityIds, getHeroAbilities } from "../constants.js";
import { heroRef, itemRef, abilityRef, rankTierToLabel } from "../mapping.js";
import { getLocaleBundle, type SupportedLanguage } from "../locales.js";
import { sampleFields } from "../stats.js";
import { stratzQuery, StratzApiError } from "../stratz.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";
import { resolveHero, stripPlaceholders } from "./reference.js";
import { heroLookupError } from "../aliases.js";

/**
 * STRATZ-powered hero aggregates (https://stratz.com — free API, requires
 * STRATZ_API_TOKEN). These complement the OpenDota tools with rank-bracket
 * and position splits OpenDota's public endpoints no longer filter by.
 * Win rates are always recomputed from raw matchCount/winCount (STRATZ's
 * precomputed rate fields use a different, opaque basis).
 */

const heroArg = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Hero id or name (English/localized, e.g. 44, 'Phantom Assassin', '幻影刺客').");

const bracketArg = z
  .enum(["herald_guardian", "crusader_archon", "legend_ancient", "divine_immortal"])
  .optional()
  .describe("Rank bracket filter. Omit for all brackets combined.");

/**
 * STRATZ bracket ranges, named with Valve's official medal terms and localized.
 * (Herald=medal 1 ... Immortal=medal 8; each range spans two medals.)
 */
const BRACKET_MEDALS: Record<string, [number, number, string]> = {
  herald_guardian: [1, 2, "low"],
  crusader_archon: [3, 4, "mid-low"],
  legend_ancient: [5, 6, "mid-high"],
  divine_immortal: [7, 8, "high"],
};
const BRACKET_QUALIFIER_I18N: Record<string, Record<string, string>> = {
  schinese: { low: "低分段", "mid-low": "中低分段", "mid-high": "中高分段", high: "高分段" },
  tchinese: { low: "低分段", "mid-low": "中低分段", "mid-high": "中高分段", high: "高分段" },
};
function bracketRangeLabel(key: string, lang?: string): string {
  const entry = BRACKET_MEDALS[key];
  if (!entry) return key;
  const [lo, hi, qual] = entry;
  const medalName = (m: number) => rankTierToLabel(m * 10, undefined, lang) ?? String(m);
  const range = `${medalName(lo)}–${medalName(hi)}`;
  const qualMap = BRACKET_QUALIFIER_I18N[String(lang ?? "english")];
  return qualMap ? `${range}（${qualMap[qual]}）` : `${range} (${qual})`;
}
function bracketAllLabel(lang?: string): string {
  return String(lang) === "schinese" || String(lang) === "tchinese" ? "全分段" : "all brackets";
}

const positionArg = z
  .enum(["1", "2", "3", "4", "5"])
  .optional()
  .describe("Filter to one position (1=carry .. 5=hard support).");

function bracketFilter(bracket?: string): string {
  return bracket ? `, bracketBasicIds: [${bracket.toUpperCase()}]` : "";
}

function positionFilter(position?: string): string {
  return position ? `, positionIds: [POSITION_${position}]` : "";
}

function pct(wins: number, games: number): number {
  return games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
}

const round1 = (n?: number | null) => (n == null ? undefined : Math.round(n * 10) / 10);

/** Row shape of the STRATZ `stats` aggregate query. */
interface StatRow {
  heroId?: number | null;
  position?: string | null;
  matchCount: number;
  winCount: number;
  level?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  heroDamage?: number | null;
  physicalDamage?: number | null;
  magicalDamage?: number | null;
  towerDamage?: number | null;
  disableDuration?: number | null;
  healingAllies?: number | null;
  networth?: number | null;
  campsStacked?: number | null;
}

async function resolveHeroId(input: number | string, lang: string): Promise<number | { error: string; hint: string }> {
  const id = await resolveHero(input, lang);
  if (id == null) {
    return heroLookupError(input, lang);
  }
  return id;
}

function wr(games: number, wins: number) {
  return { games, win_rate_pct: pct(wins, games), ...sampleFields(games, wins) };
}

interface DurationRow {
  duration_bin: number;
  games_played: number;
  wins: number;
}

/** Fetch OpenDota duration curves for a set of heroes (cached, all brackets). */
async function fetchDurations(ids: number[]): Promise<Map<number, DurationRow[]>> {
  const lists = await Promise.all(
    ids.map((id) => apiGet<DurationRow[]>(`/heroes/${id}/durations`, { ttl: "constants" }).catch(() => [] as DurationRow[])),
  );
  return new Map(ids.map((id, i) => [id, lists[i] ?? []]));
}

function timingOf(id: number, durById: Map<number, DurationRow[]>): Record<string, number> {
  const bins: Record<"early" | "mid" | "late", [number, number]> = { early: [0, 0], mid: [0, 0], late: [0, 0] };
  for (const r of durById.get(id) ?? []) {
    const m = r.duration_bin / 60;
    const slot = m < 30 ? "early" : m <= 45 ? "mid" : "late";
    bins[slot][0] += r.games_played;
    bins[slot][1] += r.wins;
  }
  const out: Record<string, number> = {};
  for (const slot of ["early", "mid", "late"] as const) {
    const [g, w] = bins[slot];
    if (g > 0) out[`${slot}_win_rate_pct`] = pct(w, g);
  }
  return out;
}

export interface ComposedLineup {
  heroes: Record<string, unknown>[];
  totals: {
    physical_damage_pct: number;
    magical_damage_pct: number;
    control_top1_pct?: number;
    team_healing?: number;
    early_win_rate_pct?: number;
    mid_win_rate_pct?: number;
    late_win_rate_pct?: number;
  };
  topControlHeroId?: number;
}

/** Aggregate a lineup's portrait from STRATZ per-hero stats + OpenDota timing curves. */
async function composeLineup(ids: number[], statById: Map<number, StatRow>, durById: Map<number, DurationRow[]>, lang: SupportedLanguage): Promise<ComposedLineup> {
  const rows = ids.map((id) => statById.get(id)).filter(Boolean) as StatRow[];
  const sum = (f: (r: StatRow) => number | null | undefined) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const physT = sum((r) => r.physicalDamage);
  const magicT = sum((r) => r.magicalDamage);
  const dmgT = physT + magicT || 1;
  const controlT = sum((r) => r.disableDuration) || 1;
  const healT = sum((r) => r.healingAllies);
  const towerT = sum((r) => r.towerDamage) || 1;
  const heroDmgT = sum((r) => r.heroDamage) || 1;
  const heroes = await Promise.all(
    ids.map(async (id) => {
      const r = statById.get(id);
      const name = (await heroRef(id, lang))?.name ?? `hero ${id}`;
      return {
        hero: name,
        ...(r ? { games: r.matchCount, win_rate_pct: pct(r.winCount, r.matchCount), ...sampleFields(r.matchCount, r.winCount) } : {}),
        ...(r && (r.physicalDamage ?? 0) + (r.magicalDamage ?? 0) > 0
          ? { damage_mix_pct: { physical: Math.round(((r.physicalDamage ?? 0) / ((r.physicalDamage ?? 0) + (r.magicalDamage ?? 0) || 1)) * 100), magical: Math.round(((r.magicalDamage ?? 0) / ((r.physicalDamage ?? 0) + (r.magicalDamage ?? 0) || 1)) * 100) } }
          : {}),
        share_of_team: {
          hero_damage_pct: r ? Math.round(((r.heroDamage ?? 0) / heroDmgT) * 100) : undefined,
          control_pct: r ? Math.round(((r.disableDuration ?? 0) / controlT) * 100) : undefined,
          healing_pct: r ? Math.round(((r.healingAllies ?? 0) / (healT || 1)) * 100) : undefined,
          tower_damage_pct: r ? Math.round(((r.towerDamage ?? 0) / towerT) * 100) : undefined,
        },
        ...(r?.networth != null ? { avg_networth: round1(r.networth) } : {}),
        timing: timingOf(id, durById),
      };
    }),
  );
  const weighted = (slot: "early" | "mid" | "late") => {
    let g = 0;
    let w = 0;
    for (const id of ids) {
      for (const r of durById.get(id) ?? []) {
        const m = r.duration_bin / 60;
        if ((slot === "early" && m < 30) || (slot === "mid" && m >= 30 && m <= 45) || (slot === "late" && m > 45)) {
          g += r.games_played;
          w += r.wins;
        }
      }
    }
    return g > 0 ? pct(w, g) : undefined;
  };
  const controlShares = ids
    .map((id) => ({ id, share: (statById.get(id)?.disableDuration ?? 0) / controlT }))
    .sort((a, b) => b.share - a.share);
  return {
    heroes,
    totals: {
      physical_damage_pct: Math.round((physT / dmgT) * 100),
      magical_damage_pct: Math.round((magicT / dmgT) * 100),
      control_top1_pct: controlShares[0] ? Math.round(controlShares[0].share * 100) : undefined,
      team_healing: round1(healT),
      early_win_rate_pct: weighted("early"),
      mid_win_rate_pct: weighted("mid"),
      late_win_rate_pct: weighted("late"),
    },
    topControlHeroId: controlShares[0]?.id,
  };
}

/** Data-backed coaching notes comparing two composed lineups (labels: e.g. "Radiant"/"Dire" or "Yours"/"Enemy"). */
async function lineupNotes(yours: ComposedLineup, enemy: ComposedLineup | undefined, lang: SupportedLanguage, labelYours = "Your", labelEnemy = "Enemy"): Promise<string[]> {
  const notes: string[] = [];
  const nameOf = async (id: number) => (await heroRef(id, lang))?.name ?? `hero ${id}`;
  const tgt = enemy ?? yours;
  const tLabel = enemy ? labelEnemy : labelYours;
  if (tgt.totals.magical_damage_pct >= 70)
    notes.push(`${tLabel} damage is ${tgt.totals.magical_damage_pct}% magical — ${enemy ? "Pipe/BKB/immunity items are high priority against them" : "expect Pipe/BKB against you; consider physical damage sources"}.`);
  if (tgt.totals.physical_damage_pct >= 70)
    notes.push(`${tLabel} damage is ${tgt.totals.physical_damage_pct}% physical — ${enemy ? "armor/Blade Mail/Ghost Scepter gain value against them" : "expect armor stacking against you"}.`);
  if ((tgt.totals.control_top1_pct ?? 0) >= 50 && tgt.topControlHeroId != null)
    notes.push(`${tLabel} control is ${tgt.totals.control_top1_pct}% concentrated on one hero (${await nameOf(tgt.topControlHeroId)}) — ${enemy ? "killing/focusing them in fights removes most of their setup" : "protect that hero's initiations"}.`);
  if (enemy) {
    const d = (a?: number, b?: number) => (a != null && b != null ? a - b : undefined);
    const lateD = d(yours.totals.late_win_rate_pct, enemy.totals.late_win_rate_pct);
    const earlyD = d(enemy.totals.early_win_rate_pct, yours.totals.early_win_rate_pct);
    if (lateD != null && lateD >= 4)
      notes.push(`${labelYours} lineup outscales (late ${yours.totals.late_win_rate_pct}% vs ${enemy.totals.late_win_rate_pct}%) — it wants to avoid forced fights before 30 min and trade space for time.`);
    else if (lateD != null && lateD <= -4)
      notes.push(`${labelEnemy} lineup outscales (late ${enemy.totals.late_win_rate_pct}% vs ${yours.totals.late_win_rate_pct}%) — ${labelYours.toLowerCase()} side wants to force tempo and end before 40 min.`);
    if (earlyD != null && earlyD >= 4)
      notes.push(`${labelEnemy} is strongest early (early ${enemy.totals.early_win_rate_pct}% vs ${yours.totals.early_win_rate_pct}%) — ${labelYours.toLowerCase()} side needs defensive wards and to avoid early rotations.`);
    const enemyHeal = enemy.totals.team_healing ?? 0;
    const yourHeal = yours.totals.team_healing ?? 0;
    if (enemyHeal > 1000 && yourHeal < enemyHeal / 5)
      notes.push(`${labelEnemy} sustain is heavy (healing ${Math.round(enemyHeal)} vs ${Math.round(yourHeal)}) — Spirit Vessel / Shiva's / burst damage gain a lot of value.`);
  }
  const nw = yours.heroes.map((h) => (h.avg_networth as number) ?? 0);
  if (nw.length > 1 && Math.max(...nw) > 0 && Math.min(...nw) > 0 && Math.max(...nw) / Math.min(...nw) > 1.6)
    notes.push(`${labelYours} gold dependency is uneven (networth spread ${Math.round(Math.min(...nw))}-${Math.round(Math.max(...nw))}) — the low-income cores need space or cheap power spikes.`);
  return notes;
}

/** Map an average medal (1-8) to the STRATZ coarse bracket enum value. */
function medalToBracket(medal: number): string | undefined {
  if (medal >= 7) return "divine_immortal";
  if (medal >= 5) return "legend_ancient";
  if (medal >= 3) return "crusader_archon";
  if (medal >= 1) return "herald_guardian";
  return undefined;
}

interface PairRow {
  heroId2: number;
  matchCount: number;
  winCount: number;
}

/** A recommendation row's counter evidence against one enemy. */
function counterRow(p: PairRow) {
  // Pair rows are (enemy=heroId1, candidate=heroId2) from the ENEMY's
  // disadvantage list, so the candidate's wins are the enemy's losses.
  const candidateWins = p.matchCount - p.winCount;
  return { games: p.matchCount, win_rate_pct: pct(candidateWins, p.matchCount), ...sampleFields(p.matchCount, candidateWins) };
}

/** Wrap STRATZ failures into tool-result errors instead of protocol errors. */
function stratzErrorResult(err: unknown): { error: string; hint?: string } {
  if (err instanceof StratzApiError) {
    return {
      error: err.message,
      hint:
        err.status === 401 || err.status === 403
          ? "Renew the token at https://stratz.com/api and update STRATZ_API_TOKEN."
          : "Retry shortly; STRATZ aggregates are cached, repeated calls are cheap.",
    };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

const rawStratzTools: ToolDef[] = [
  {
    name: "get_matchups_by_rank",
    description:
      "Hero counters WITH RANK-BRACKET FILTER, from STRATZ's full match pool (much larger samples than " +
      "get_hero_matchups). Returns who the hero beats (win rate > 52%) and who it struggles against (< 48%), " +
      "each with games, win rate and a 95% confidence interval. Pass vs_hero to get ONE exact pairing's win " +
      "rate — works even for mid-table matchups that don't make either list. Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      vs_hero: z
        .union([z.number().int().positive(), z.string().min(1)])
        .optional()
        .describe(
          "Optional: one specific opposing hero. Returns its exact matchup row (games, win rate, ci95) even when the pairing is too mid-table for the strong/struggles lists.",
        ),
      take: z.number().int().min(3).max(20).optional().describe("Rows per list (default 10)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const take = args.take ?? 10;
      // take: 120 = full hero pool, so mid-table matchups (48-52%) are fetched too.
      const data = await stratzQuery<{ heroStats: { heroVsHeroMatchup: { advantage: { vs: PairRow[] }[]; disadvantage: { vs: PairRow[] }[] } | null } }>(
        "heroVsHeroMatchup",
        `query { heroStats { heroVsHeroMatchup(heroId: ${heroId}${bracketFilter(args.bracket)}, take: 120) ` +
          `{ advantage { heroId vs { heroId2 matchCount winCount } } disadvantage { heroId vs { heroId2 matchCount winCount } } } } }`,
      );
      const mu = data?.heroStats?.heroVsHeroMatchup;
      const pairs = new Map<number, PairRow>();
      for (const p of [...(mu?.advantage?.[0]?.vs ?? []), ...(mu?.disadvantage?.[0]?.vs ?? [])]) {
        if (p.heroId2 !== heroId && (!pairs.has(p.heroId2) || p.matchCount > pairs.get(p.heroId2)!.matchCount)) {
          pairs.set(p.heroId2, p);
        }
      }
      let vsMatchup: Record<string, unknown> | undefined;
      if (args.vs_hero != null) {
        const vsHeroId = await resolveHeroId(args.vs_hero, lang);
        if (typeof vsHeroId === "object") return vsHeroId;
        if (vsHeroId === heroId) {
          return { error: "vs_hero is the same hero — heroVsHeroMatchup only covers different-hero pairings." };
        }
        const row = pairs.get(vsHeroId);
        if (row) {
          const wrPct = pct(row.winCount, row.matchCount);
          vsMatchup = {
            hero: (await heroRef(heroId, lang))?.name,
            vs_hero: (await heroRef(vsHeroId, lang))?.name,
            stance: wrPct >= 52 ? "favored" : wrPct <= 48 ? "unfavored" : "even",
            ...wr(row.matchCount, row.winCount),
          };
        } else {
          vsMatchup = { vs_hero: (await heroRef(vsHeroId, lang))?.name, note: "no games against this hero in the current pool" };
        }
      }
      const rows = await Promise.all(
        [...pairs.values()].map(async (p) => ({
          hero: (await heroRef(p.heroId2, lang))?.name ?? `hero ${p.heroId2}`,
          ...wr(p.matchCount, p.winCount),
        })),
      );
      const strong = rows.filter((r) => r.win_rate_pct >= 52).sort((a, b) => b.win_rate_pct - a.win_rate_pct).slice(0, take);
      const weak = rows.filter((r) => r.win_rate_pct <= 48).sort((a, b) => a.win_rate_pct - b.win_rate_pct).slice(0, take);
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        ...(vsMatchup ? { vs_hero_matchup: vsMatchup } : {}),
        strong_against: strong,
        struggles_against: weak,
        note: "Win rates are this hero's, recomputed from raw counts; use ci95_pp when quoting numbers.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_item_builds_by_rank",
    description:
      "Item purchase stats WITH RANK-BRACKET AND POSITION FILTER, from STRATZ: for each item, how many games " +
      "the hero bought it, the average purchase minute, and the win rate in those games. Use for 'what items " +
      "does PA buy at Divine and does BKB-first actually win'. Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      position: positionArg,
      min_games: z.number().int().min(1).optional().describe("Min games per timing bucket upstream (default 20)."),
      limit: z.number().int().min(5).max(40).optional().describe("Max items returned (default 15)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const data = await stratzQuery<{ heroStats: { itemFullPurchase: { itemId: number; matchCount: number; winCount: number; time: number }[] | null } }>(
        "itemFullPurchase",
        `query { heroStats { itemFullPurchase(heroId: ${heroId}${bracketFilter(args.bracket)}${positionFilter(args.position)}, matchLimit: ${args.min_games ?? 20}) ` +
          `{ itemId time matchCount winCount } } }`,
      );
      const agg = new Map<number, { games: number; wins: number; weightedMin: number }>();
      for (const r of data?.heroStats?.itemFullPurchase ?? []) {
        const cur = agg.get(r.itemId) ?? { games: 0, wins: 0, weightedMin: 0 };
        cur.games += r.matchCount;
        cur.wins += r.winCount;
        cur.weightedMin += r.time * r.matchCount;
        agg.set(r.itemId, cur);
      }
      const rows = (
        await Promise.all(
          [...agg.entries()].map(async ([itemId, a]) => {
            const ref = await itemRef(itemId, lang);
            return {
              item: ref?.name ?? `item ${itemId}`,
              games: a.games,
              avg_purchase_min: Math.round(a.weightedMin / a.games),
              win_rate_pct: pct(a.wins, a.games),
              ...sampleFields(a.games, a.wins),
            };
          }),
        )
      )
        .sort((a, b) => b.games - a.games)
        .slice(0, args.limit ?? 15);
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        position: args.position ? `position ${args.position}` : "all positions",
        items: rows,
        note: "Repeated purchases (e.g. consumables) count every timing bucket; win rate is across games with a purchase of that item.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_talent_stats",
    description:
      "Talent pick stats WITH RANK-BRACKET AND POSITION FILTER, from STRATZ: games and win rate for each talent " +
      "the hero picked. Use for 'which PA talent tree choice actually wins at my bracket' (pairs with " +
      "get_hero_kit for what each talent does). Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      position: positionArg,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const data = await stratzQuery<{ heroStats: { talent: { abilityId: number; matchCount: number; winCount: number }[] | null } }>(
        "talent",
        `query { heroStats { talent(heroId: ${heroId}${bracketFilter(args.bracket)}${positionFilter(args.position)}) ` +
          `{ abilityId matchCount winCount } } }`,
      );
      const internalHero = getLocaleBundle("english").heroes[String(heroId)]?.internal ?? "";
      const kit = await getHeroAbilities().then (t => t[internalHero]).catch(() => undefined);
      const abilityIds = await getAbilityIds().catch(() => ({}) as Record<string, string>);
      const talentLevel = new Map<string, number | undefined>();
      for (const t of kit?.talents ?? []) talentLevel.set(t.name, t.level);
      const rows = (
        await Promise.all(
          (data?.heroStats?.talent ?? []).map(async (r) => {
            const ref = await abilityRef(r.abilityId, lang);
            const internal = abilityIds[String(r.abilityId)];
            return {
              level: internal ? talentLevel.get(internal) : undefined,
              talent: stripPlaceholders(ref?.name ?? `talent ${r.abilityId}`),
              ...wr(r.matchCount, r.winCount),
            };
          }),
        )
      )
        .sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || b.games - a.games);
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        position: args.position ? `position ${args.position}` : "all positions",
        talents: rows,
        note: "Counts cover games where the talent was picked (both branches of a tier never sum to all games).",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_lane_matchups",
    description:
      "LANE outcomes vs each opponent hero (win/loss/draw of the lane, not the game), with rank-bracket filter, " +
      "from STRATZ. Use for 'who does PA struggle against in lane at Legend' — complements get_matchups_by_rank " +
      "(game-level counters). Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      position: positionArg,
      min_games: z.number().int().min(1).optional().describe("Min lane games per opponent (default 30)."),
      take: z.number().int().min(3).max(15).optional().describe("Rows per list (default 8)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const data = await stratzQuery<
        { heroStats: { laneOutcome: { heroId2: number; winCount: number; lossCount: number; drawCount: number }[] | null } }
      >(
        "laneOutcome",
        `query { heroStats { laneOutcome(heroId: ${heroId}, isWith: false${bracketFilter(args.bracket)}${positionFilter(args.position)}) ` +
          `{ heroId2 winCount lossCount drawCount } } }`,
      );
      const minGames = args.min_games ?? 30;
      const take = args.take ?? 8;
      const rows = (
        await Promise.all(
          (data?.heroStats?.laneOutcome ?? [])
            .filter((r) => r.winCount + r.lossCount + r.drawCount >= minGames && r.heroId2 !== heroId)
            .map(async (r) => {
              const decided = r.winCount + r.lossCount + r.drawCount;
              return {
                opponent: (await heroRef(r.heroId2, lang))?.name ?? `hero ${r.heroId2}`,
                lane_games: decided,
                lane_win_rate_pct: pct(r.winCount, decided),
                ...sampleFields(decided, r.winCount),
              };
            }),
        )
      ).sort((a, b) => a.lane_win_rate_pct - b.lane_win_rate_pct);
      const total = rows.reduce((s, r) => s + r.lane_games, 0);
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        hardest_lanes: rows.slice(0, take),
        easiest_lanes: rows.slice(-take).reverse(),
        overall: `aggregated lane games in sample: ${total}`,
        note: "Lane outcome is the lane phase result (win/loss/draw); a few matches record no lane outcome and are excluded.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_draft_advice",
    description:
      "COUNTER-PICK recommendation for a draft, from STRATZ: given the enemy lineup (and optionally your allies), " +
      "ranks candidate heroes by how many enemies they beat (bracket-filtered hero-vs-hero win rates), and shows " +
      "ally synergy when allies are provided. One question this answers: 'enemy has PA, Axe and Bane — what do I " +
      "pick at Divine?'. Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      enemy_heroes: z.array(heroArg).min(1).max(5).describe("Enemy hero ids or names (already picked/banned-visible)."),
      ally_heroes: z.array(heroArg).max(4).optional().describe("Your team's picks, for synergy annotations."),
      bracket: bracketArg,
      take: z.number().int().min(3).max(15).optional().describe("Max recommendations (default 8)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const enemyIds: number[] = [];
      for (const h of args.enemy_heroes) {
        const id = await resolveHeroId(h, lang);
        if (typeof id === "object") return id;
        enemyIds.push(id);
      }
      const allyIds: number[] = [];
      for (const h of args.ally_heroes ?? []) {
        const id = await resolveHeroId(h, lang);
        if (typeof id === "object") return id;
        allyIds.push(id);
      }
      const bracket = bracketFilter(args.bracket);
      // One batched request: each enemy's disadvantage list (= heroes that beat
      // that enemy), plus one matchUp covering all allies for synergy pairs.
      const parts = enemyIds.map(
        (id, i) =>
          `e${i}: heroVsHeroMatchup(heroId: ${id}${bracket}, take: 40) { disadvantage { vs { heroId2 matchCount winCount } } }`,
      );
      if (allyIds.length) {
        parts.push(
          `synergy: matchUp(heroIds: [${allyIds.join(",")}]${bracket}, take: 40) { with { heroId2 matchCount winCount synergy } }`,
        );
      }
      const data = await stratzQuery<{ heroStats: Record<string, unknown> }>(
        "draftAdvice",
        `query { heroStats { ${parts.join(" ")} } }`,
      );
      const hs = data?.heroStats ?? {};
      const picked = new Set([...enemyIds, ...allyIds]);
      const counters = new Map<number, { total: number; wrSum: number; gamesMin: number; perEnemy: Map<number, PairRow> }>();
      for (let i = 0; i < enemyIds.length; i++) {
        const list = ((hs[`e${i}`] as { disadvantage?: { vs?: PairRow[] }[] } | null)?.disadvantage?.[0]?.vs ?? []).filter(
          (p) => !picked.has(p.heroId2),
        );
        for (const p of list) {
          const cur = counters.get(p.heroId2) ?? { total: 0, wrSum: 0, gamesMin: Infinity, perEnemy: new Map() };
          cur.total += 1;
          cur.wrSum += (p.matchCount - p.winCount) / p.matchCount;
          cur.gamesMin = Math.min(cur.gamesMin, p.matchCount);
          cur.perEnemy.set(enemyIds[i], p);
          counters.set(p.heroId2, cur);
        }
      }
      // matchUp returns one dryad per queried ally; collect each ally's pair
      // stats with the candidates so recommendations can carry real synergy.
      const synergyByCandidate = new Map<number, { allyId: number; games: number; wins: number }[]>();
      const synergyDryads = (hs.synergy as { with?: PairRow[] }[] | null) ?? [];
      synergyDryads.forEach((dryad, allyIndex) => {
        for (const p of dryad.with ?? []) {
          if (picked.has(p.heroId2)) continue;
          const list = synergyByCandidate.get(p.heroId2) ?? [];
          list.push({ allyId: allyIds[allyIndex], games: p.matchCount, wins: p.winCount });
          synergyByCandidate.set(p.heroId2, list);
        }
      });
      const ranked = [...counters.entries()]
        .filter(([, c]) => c.gamesMin >= 30)
        .sort((a, b) => b[1].total - a[1].total || b[1].wrSum / b[1].total - a[1].wrSum / a[1].total)
        .slice(0, args.take ?? 8);
      const recommendations = await Promise.all(
        ranked.map(async ([candId, c]) => {
          const perEnemy = await Promise.all(
            [...c.perEnemy.entries()].map(async ([enemyId, p]) => ({
              enemy: (await heroRef(enemyId, lang))?.name ?? `hero ${enemyId}`,
              ...counterRow(p),
            })),
          );
          const synList = synergyByCandidate.get(candId);
          const allySynergy = await Promise.all(
            (synList ?? []).map(async (s) => ({
              ally: (await heroRef(s.allyId, lang))?.name ?? `hero ${s.allyId}`,
              ...wr(s.games, s.wins),
            })),
          );
          return {
            hero: (await heroRef(candId, lang))?.name ?? `hero ${candId}`,
            enemies_countered: c.total,
            avg_win_rate_pct: Math.round((c.wrSum / c.total) * 1000) / 10,
            counters: perEnemy.sort((a, b) => b.win_rate_pct - a.win_rate_pct),
            ...(allySynergy.length ? { ally_synergy: allySynergy } : {}),
          };
        }),
      );
      return {
        enemies: await Promise.all(enemyIds.map((id) => heroRef(id, lang).then((r) => r?.name ?? `hero ${id}`))),
        ...(allyIds.length
          ? { allies: await Promise.all(allyIds.map((id) => heroRef(id, lang).then((r) => r?.name ?? `hero ${id}`))) }
          : {}),
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        recommendations,
        note: "Candidates ranked by how many enemies they beat (>= 30 games per matchup); win rates are the candidate's, from the enemy's disadvantage pairs.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_draft_composition",
    description:
      "LINEUP COMPOSITION analysis at coach level, from STRATZ per-hero aggregates + OpenDota duration curves: " +
      "damage mix (physical vs magical share), control/healing/push distribution, gold dependency, and each " +
      "lineup's early/mid/late win-rate windows, then data-backed coaching notes (e.g. 'their damage is 78% " +
      "magical — Pipe/BKB was the right call', 'their control sat on one hero', 'they outscale: the game had " +
      "to end before 40 min'). Works for POST-GAME review (feed both lineups from get_match) and for draft " +
      "planning; for a one-call post-game report use get_match_coaching. Sources: stratz.com + opendota " +
      "durations; requires STRATZ_API_TOKEN.",
    schema: {
      team_heroes: z.array(heroArg).min(1).max(5).describe("One lineup (hero ids or names) — e.g. your team from the match being reviewed."),
      enemy_heroes: z.array(heroArg).max(5).optional().describe("The opposing lineup."),
      bracket: bracketArg,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const resolveAll = async (list: (number | string)[]) => {
        const ids: number[] = [];
        for (const h of list) {
          const id = await resolveHeroId(h, lang);
          if (typeof id === "object") return id;
          ids.push(id);
        }
        return ids;
      };
      const teamIds = await resolveAll(args.team_heroes);
      if (!Array.isArray(teamIds)) return teamIds as unknown as { error: string; hint: string };
      const enemyIds = args.enemy_heroes ? ((await resolveAll(args.enemy_heroes)) as number[]) : [];
      if (args.enemy_heroes && !Array.isArray(enemyIds)) return enemyIds as unknown as { error: string; hint: string };
      const allIds = [...teamIds, ...enemyIds];

      const [statsResp, durById] = await Promise.all([
        stratzQuery<{ heroStats: { stats: StatRow[] | undefined } }>(
          "statsAggregate",
          `query { heroStats { stats(heroIds: [${allIds.join(",")}]${bracketFilter(args.bracket)}) ` +
            `{ heroId matchCount winCount heroDamage physicalDamage magicalDamage towerDamage disableDuration healingAllies networth } } }`,
        ),
        fetchDurations(allIds),
      ]);
      const statById = new Map((statsResp?.heroStats?.stats ?? []).map((r) => [r.heroId ?? -1, r]));

      const yours = await composeLineup(teamIds, statById, durById, lang);
      const enemy = enemyIds.length ? await composeLineup(enemyIds, statById, durById, lang) : undefined;
      const notes = await lineupNotes(yours, enemy, lang, "Your", "Enemy");

      return {
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        yours: { heroes: yours.heroes, totals: yours.totals },
        ...(enemy ? { enemy: { heroes: enemy.heroes, totals: enemy.totals } } : {}),
        coach_notes: notes,
        note: "Shares are within-lineup relative (STRATZ raw per-game values; absolute units undocumented). Timing windows use OpenDota duration curves, all brackets. Use get_draft_advice for counter picks on top of this.",
        source: "stratz.com + opendota",
      };
    },
  },
  {
    name: "get_match_coaching",
    description:
      "ONE-CALL POST-GAME COACHING REPORT. Feed a match_id and it pulls the match, detects the rank bracket " +
      "from the players' medals, then returns: both lineups' composition portraits (damage mix, control " +
      "concentration, sustain, early/mid/late windows), every player's core numbers AGAINST that bracket's " +
      "per-hero averages (who under/over-performed), a timing verdict (did the losing lineup die inside its " +
      "weak window / fail to close in its strong one), and data-backed coach notes explaining the result. " +
      "This is the starting point for 'why did we lose' — follow up with get_match (fights/lane detail) and " +
      "get_item_winrate_vs_hero (item post-mortems). Requires STRATZ_API_TOKEN.",
    schema: {
      match_id: z.number().int().positive().describe("The match id to review."),
      focus_account_id: z.number().int().positive().optional().describe("Highlight one player (usually the asking player)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      interface MPlayer {
        hero_id: number;
        player_slot: number;
        account_id?: number;
        personaname?: string;
        level?: number;
        kills?: number;
        deaths?: number;
        assists?: number;
        hero_damage?: number;
        tower_damage?: number;
        gold_per_min?: number;
        rank_tier?: number;
        damage?: Record<string, number>;
        killed?: Record<string, number>;
      }
      const match = await apiGet<{ radiant_win?: boolean; duration?: number; players?: MPlayer[]; teamfights?: Record<string, any>[]; objectives?: Record<string, any>[] }>(`/matches/${args.match_id}`, { ttl: "match" });
      const parsed = match.teamfights != null || match.players?.[0]?.damage != null;
      // Lane results / positions / participation come from the OpenDota enrichment pipeline.
      const enriched = await enrichMatch(match as unknown as Record<string, any>, lang, {});
      const ePlayers = (enriched.players ?? []) as Record<string, any>[];
      const internalToHeroId = new Map(
        Object.entries(getLocaleBundle("english").heroes).map(([id, h]) => [h.internal, Number(id)]),
      );
      const players = match?.players ?? [];
      if (players.length < 2) {
        return { error: `Match ${args.match_id} has no player data (possibly too recent or invalid id).`, hint: "Verify with get_match first." };
      }
      const radiant = players.filter((p) => p.player_slot < 128);
      const dire = players.filter((p) => p.player_slot >= 128);
      const medals = players.map((p) => Math.floor((p.rank_tier ?? 0) / 10)).filter((m) => m > 0);
      const avgMedal = medals.length ? medals.reduce((s, m) => s + m, 0) / medals.length : 0;
      const bracket = medalToBracket(avgMedal);
      const allIds = [...new Set(players.map((p) => p.hero_id).filter((id) => id > 0))];

      const [statsResp, durById] = await Promise.all([
        stratzQuery<{ heroStats: { stats: StatRow[] | undefined } }>(
          "statsAggregate",
          `query { heroStats { stats(heroIds: [${allIds.join(",")}]${bracketFilter(bracket)}) ` +
            `{ heroId matchCount winCount heroDamage physicalDamage magicalDamage towerDamage disableDuration healingAllies networth level kills deaths assists } } }`,
        ),
        fetchDurations(allIds),
      ]);
      const statById = new Map((statsResp?.heroStats?.stats ?? []).map((r) => [r.heroId ?? -1, r]));

      const radiantLineup = await composeLineup(radiant.map((p) => p.hero_id), statById, durById, lang);
      const direLineup = await composeLineup(dire.map((p) => p.hero_id), statById, durById, lang);
      const notes = await lineupNotes(radiantLineup, direLineup, lang, "Radiant", "Dire");

      // Player-by-player: actual numbers vs this bracket's per-hero averages,
      // plus in-match detail from the parsed replay (damage targets, solo kills, lane, participation).
      const deltaPct = (actual: number | undefined, avg: number | null | undefined) =>
        actual != null && avg != null && avg > 0 ? Math.round(((actual - avg) / avg) * 1000) / 10 : undefined;
      const heroTargetRows = async (map: Record<string, number> | undefined, label: string) => {
        if (!map) return undefined;
        const entries = Object.entries(map)
          .filter(([k, v]) => k.startsWith("npc_dota_hero_") && !k.startsWith("illusion_") && v > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        if (!entries.length) return undefined;
        const total = entries.reduce((s, [, v]) => s + v, 0);
        return {
          total: Object.entries(map).filter(([k]) => k.startsWith("npc_dota_hero_") && !k.startsWith("illusion_")).reduce((s, [, v]) => s + v, 0),
          [label]: await Promise.all(
            entries.map(async ([internal, v]) => ({
              hero: (await heroRef(internalToHeroId.get(internal) ?? -1, lang))?.name ?? internal,
              value: v,
            })),
          ),
        };
      };
      const perf = await Promise.all(
        players.map(async (p, i) => {
          const avg = statById.get(p.hero_id);
          const isRadiant = p.player_slot < 128;
          const win = match.radiant_win != null ? match.radiant_win === isRadiant : undefined;
          const e = ePlayers[i] ?? {};
          const dmg = await heroTargetRows(p.damage, "top_targets");
          const kills = await heroTargetRows(p.killed, "solo_kills");
          return {
            player: p.personaname ?? `account ${p.account_id ?? "?"}`,
            ...(p.account_id ? { account_id: p.account_id } : {}),
            hero: (await heroRef(p.hero_id, lang))?.name ?? `hero ${p.hero_id}`,
            side: isRadiant ? "radiant" : "dire",
            ...(win != null ? { win } : {}),
            ...(args.focus_account_id && p.account_id === args.focus_account_id ? { focus: true } : {}),
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            gold_per_min: p.gold_per_min,
            ...(e.lane_result ? { lane_result: e.lane_result } : {}),
            ...(e.position ? { position: e.position } : {}),
            ...(e.lane_efficiency_pct != null ? { lane_efficiency_pct: e.lane_efficiency_pct } : {}),
            ...(e.teamfight_participation != null ? { teamfight_participation: e.teamfight_participation } : {}),
            ...(e.towers_killed != null ? { towers_killed: e.towers_killed } : {}),
            ...(e.roshans_killed != null ? { roshans_killed: e.roshans_killed } : {}),
            ...(dmg ? { hero_damage_on: dmg } : {}),
            ...(kills ? { kill_map: kills } : {}),
            vs_bracket_avg_pct: avg
              ? {
                  level: deltaPct(p.level, avg.level),
                  hero_damage: deltaPct(p.hero_damage, avg.heroDamage),
                  tower_damage: deltaPct(p.tower_damage, avg.towerDamage),
                  kills: deltaPct(p.kills, avg.kills),
                  deaths: deltaPct(p.deaths, avg.deaths),
                }
              : undefined,
          };
        }),
      );

      // Decisive team fights: rank by net gold swing between the two sides.
      const decisiveFights = (match.teamfights ?? [])
        .map((tf) => {
          let radiantGold = 0;
          let direGold = 0;
          const absent: string[] = [];
          (tf.players ?? []).forEach((tp: Record<string, any>, idx: number) => {
            const delta = Number(tp.gold_delta ?? 0);
            if (players[idx]?.player_slot == null) return;
            const isRadiant = players[idx].player_slot < 128;
            if (isRadiant) radiantGold += delta;
            else direGold += delta;
            const participated = (tp.deaths ?? 0) > 0 || Math.abs(delta) > 0 || (tp.xp_delta ?? 0) !== 0;
            if (!participated) absent.push(players[idx].hero_id.toString());
          });
          return { start: Number(tf.start ?? 0), end: Number(tf.end ?? 0), deaths: Number(tf.deaths ?? 0), radiant_net_gold: radiantGold - direGold, absentHeroIds: absent.map(Number) };
        })
        .sort((a, b) => Math.abs(b.radiant_net_gold) - Math.abs(a.radiant_net_gold))
        .slice(0, 3)
        .sort((a, b) => a.start - b.start);
      const decisive_teamfights = await Promise.all(
        decisiveFights.map(async (f) => ({
          at_min: Math.round(f.start / 60),
          lasted_s: f.end - f.start,
          deaths: f.deaths,
          net_gold_radiant: f.radiant_net_gold,
          absent: await Promise.all(f.absentHeroIds.map(async (id) => (await heroRef(id, lang))?.name ?? `hero ${id}`)),
        })),
      );

      // Objective timeline: roshans, first tower, first barracks.
      const roshans = (match.objectives ?? [])
        .filter((o) => o.type === "CHAT_MESSAGE_ROSHAN_KILL")
        .map((o) => ({ at_min: Math.round(Number(o.time ?? 0) / 60), team: o.team === 2 ? "radiant" : o.team === 3 ? "dire" : `team ${o.team}` }));
      const firstTower = (match.objectives ?? []).find((o) => o.type === "CHAT_MESSAGE_TOWER_KILL" && o.key == null);
      const firstBarracks = (match.objectives ?? []).find((o) => o.type === "CHAT_MESSAGE_BARRACKS_KILL");

      // Timing verdict: where did the game end relative to each lineup's windows?
      const durationMin = match.duration ? Math.round(match.duration / 60) : undefined;
      const loser = match.radiant_win == null ? undefined : match.radiant_win ? direLineup : radiantLineup;
      const winner = match.radiant_win == null ? undefined : match.radiant_win ? radiantLineup : direLineup;
      let timing_verdict: string | undefined;
      if (durationMin != null && loser && winner) {
        const loserLate = loser.totals.late_win_rate_pct;
        const winnerLate = winner.totals.late_win_rate_pct;
        const loserEarly = loser.totals.early_win_rate_pct;
        if (loserLate != null && winnerLate != null && loserLate - winnerLate >= 4 && durationMin <= 40)
          timing_verdict = `The losing lineup actually scales better (late ${loserLate}% vs ${winnerLate}%) but the game ended at ${durationMin} min — it never reached its window. The loss is about early/mid game tempo, not draft scaling.`;
        else if (loserEarly != null && winnerLate != null && durationMin >= 45)
          timing_verdict = `The game dragged to ${durationMin} min past the losing lineup's effective window — the win condition for the other side was simply patience.`;
        else
          timing_verdict = `Game ended at ${durationMin} min; neither lineup had a decisive scaling edge (windows within 4pp), so execution decided it.`;
      }

      return {
        match_id: args.match_id,
        winner: match.radiant_win == null ? undefined : match.radiant_win ? "radiant" : "dire",
        duration_min: durationMin,
        parsed,
        bracket: bracket ? `${bracketRangeLabel(bracket, lang)}（按玩家段位检测）` : bracketAllLabel(lang),
        ...(enriched.losing_team_max_gold_lead != null ? { losing_team_max_gold_lead: enriched.losing_team_max_gold_lead } : {}),
        ...(parsed
          ? {
              objective_timeline: {
                ...(roshans.length ? { roshans } : {}),
                ...(firstTower ? { first_tower_min: Math.round(Number(firstTower.time ?? 0) / 60) } : {}),
                ...(firstBarracks ? { first_barracks_min: Math.round(Number(firstBarracks.time ?? 0) / 60) } : {}),
              },
              decisive_teamfights,
            }
          : { note_unparsed: "Match not parsed yet — no teamfight/objective/lane detail. Call request_match_parse then retry for the full report." }),
        lineups: {
          radiant: { heroes: radiantLineup.heroes, totals: radiantLineup.totals },
          dire: { heroes: direLineup.heroes, totals: direLineup.totals },
        },
        players_vs_bracket_avg: perf,
        ...(timing_verdict ? { timing_verdict } : {}),
        coach_notes: notes,
        note: "vs_bracket_avg_pct compares this game's numbers with the bracket's per-game averages for that hero (negative = below bracket norm). hero_damage_on shows WHO each player's damage actually went to (illusions excluded) — check cores hit the enemy carry. For item post-mortems call get_item_winrate_vs_hero; for full fight logs use get_match with include.",
        source: "opendota parsed match + stratz.com aggregates",
      };
    },
  },
  {
    name: "get_skill_builds_by_rank",
    description:
      "Skill build stats WITH RANK-BRACKET AND POSITION FILTER, from STRATZ: for each ability, at what " +
      "HERO LEVEL players first put a point in it and at what hero level they max it, with games, share " +
      "and win rates. Answers 'when does PA take ult / at what level is Strike maxed at my bracket'. " +
      "Pairs with get_talent_stats (talent choices) and the OpenDota get_skill_builds (exact per-level " +
      "order, all brackets). Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      position: positionArg,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const data = await stratzQuery<{ heroStats: Record<string, { abilityId: number; level: number; matchCount: number; winCount: number }[] | undefined> }>(
        "abilityLevels",
        `query { heroStats { mn: abilityMinLevel(heroId: ${heroId}${bracketFilter(args.bracket)}${positionFilter(args.position)}) ` +
          `{ abilityId level matchCount winCount } mx: abilityMaxLevel(heroId: ${heroId}${bracketFilter(args.bracket)}${positionFilter(args.position)}) ` +
          `{ abilityId level matchCount winCount } } }`,
      );
      const mn = data?.heroStats?.mn ?? [];
      const mx = data?.heroStats?.mx ?? [];
      // Keep only the hero's own kit abilities (rows also include talents and facet-granted skills).
      const internalHero = getLocaleBundle("english").heroes[String(heroId)]?.internal ?? "";
      const kit = await getHeroAbilities().then((t) => t[internalHero]).catch(() => undefined);
      const abilityIds = await getAbilityIds().catch(() => ({}) as Record<string, string>);
      const internalToId = new Map(Object.entries(abilityIds).map(([id, internal]) => [String(internal), Number(id)]));
      const kitIds = (kit?.abilities ?? []).map((a) => internalToId.get(a)).filter((id): id is number => id != null);
      const dominant = (rows: typeof mn) => {
        if (!rows.length) return undefined;
        const total = rows.reduce((s, r) => s + r.matchCount, 0);
        const sorted = rows.slice().sort((a, b) => b.matchCount - a.matchCount);
        const main = sorted[0];
        const alts = sorted.slice(1, 3).filter((r) => r.matchCount / total >= 0.05);
        return {
          hero_level: main.level,
          games: main.matchCount,
          share_pct: Math.round((main.matchCount / total) * 1000) / 10,
          win_rate_pct: pct(main.winCount, main.matchCount),
          ...sampleFields(main.matchCount, main.winCount),
          ...(alts.length
            ? { alternatives: alts.map((r) => ({ hero_level: r.level, share_pct: Math.round((r.matchCount / total) * 1000) / 10, win_rate_pct: pct(r.winCount, r.matchCount) })) }
            : {}),
        };
      };
      const rows = await Promise.all(
        kitIds.map(async (id) => {
          const ref = await abilityRef(id, lang);
          const first = dominant(mn.filter((r) => r.abilityId === id));
          const maxed = dominant(mx.filter((r) => r.abilityId === id));
          return { ability: ref?.name ?? `ability ${id}`, ...(first ? { first_point: first } : {}), ...(maxed ? { maxed: maxed } : {}) };
        }),
      );
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        position: args.position ? `position ${args.position}` : "all positions",
        abilities: rows.filter((r) => r.first_point || r.maxed),
        note: "first_point = hero level when the ability gets its first skill point (dominant choice + share); maxed = hero level when it reaches its final level. Talents/facet skills are excluded — use get_talent_stats.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_hero_position_stats",
    description:
      "Per-POSITION performance for a hero with rank-bracket filter, from STRATZ: games and win rate at " +
      "each of positions 1-5 plus the full picture (avg K/D/A, level, hero/physical/magical damage, tower " +
      "damage, camps stacked). Answers 'does PA work as a 2 or is she 1-only at my bracket' with real " +
      "sample sizes. Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const data = await stratzQuery<{ heroStats: { stats: StatRow[] | undefined } }>(
        "statsByPosition",
        `query { heroStats { stats(heroIds: [${heroId}]${bracketFilter(args.bracket)}, groupByPosition: true) ` +
          `{ heroId position matchCount winCount level kills deaths assists heroDamage physicalDamage magicalDamage towerDamage campsStacked } } }`,
      );
      const rows = (data?.heroStats?.stats ?? [])
        .filter((r) => r.position?.startsWith("POSITION_"))
        .map((r) => ({
          position: Number(r.position!.slice("POSITION_".length)),
          games: r.matchCount,
          win_rate_pct: pct(r.winCount, r.matchCount),
          ...sampleFields(r.matchCount, r.winCount),
          avg: {
            level: round1(r.level),
            kills: round1(r.kills),
            deaths: round1(r.deaths),
            assists: round1(r.assists),
            hero_damage: round1(r.heroDamage),
            tower_damage: round1(r.towerDamage),
            camps_stacked: round1(r.campsStacked),
          },
        }))
        .sort((a, b) => b.games - a.games);
      const best = rows.slice().sort((a, b) => b.games * (b.win_rate_pct ?? 0) - a.games * (a.win_rate_pct ?? 0))[0];
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        positions: rows,
        ...(best ? { most_played: { position: best.position, win_rate_pct: best.win_rate_pct, games: best.games } } : {}),
        note: "Averages are per game; damage fields are STRATZ raw values (use for within-hero comparison). Off-position samples are often tiny — check low_sample before judging.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_hero_trend",
    description:
      "Hero win rate per PATCH (optionally per fine rank bracket), from STRATZ — shows whether a hero is being " +
      "nerfed into the ground or rising this patch. Use for 'is PA still good after 7.40b'. " +
      "Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: z
        .enum(["herald", "guardian", "crusader", "archon", "legend", "ancient", "divine", "immortal"])
        .optional()
        .describe("Fine rank bracket (this endpoint supports all 8). Omit for all."),
      patches: z.number().int().min(2).max(15).optional().describe("How many recent patches (default 6)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const bracketArg = args.bracket ? `, bracketIds: ${args.bracket.toUpperCase()}` : "";
      const [stats, versionsResp] = await Promise.all([
        stratzQuery<{ heroStats: { winGameVersion: { gameVersionId: number; winCount: number; matchCount: number }[] | null } }>(
          "winGameVersion",
          `query { heroStats { winGameVersion(heroIds: [${heroId}]${bracketArg}, take: ${args.patches ?? 6}) ` +
            `{ gameVersionId winCount matchCount } } }`,
        ),
        stratzQuery<{ constants: { gameVersions: { id: number; name: string }[] } }>(
          "gameVersions",
          `query { constants { gameVersions { id name } } }`,
          { ttlMs: 24 * 60 * 60_000 },
        ),
      ]);
      const versionName = new Map((versionsResp?.constants?.gameVersions ?? []).map((v) => [v.id, v.name]));
      const rows: { patch: string; games: number; win_rate_pct: number; win_rate_ci95_pp?: number; low_sample?: boolean; delta_vs_prev_patch_pp?: number }[] = (stats?.heroStats?.winGameVersion ?? [])
        .map((r) => ({ patch: versionName.get(r.gameVersionId) ?? `version ${r.gameVersionId}`, ...wr(r.matchCount, r.winCount) }))
        .sort((a, b) => b.patch.localeCompare(a.patch, undefined, { numeric: true }));
      for (let i = 0; i < rows.length - 1; i++) {
        rows[i].delta_vs_prev_patch_pp = Math.round((rows[i].win_rate_pct - rows[i + 1].win_rate_pct) * 10) / 10;
      }
      return {
        hero: (await heroRef(heroId, lang))?.name,
        bracket: args.bracket ? bracketRangeLabel(args.bracket, lang) : bracketAllLabel(lang),
        by_patch: rows,
        source: "stratz.com",
      };
    },
  },
];

/** STRATZ tools with failures normalized to {error, hint} results. */
export const stratzTools: ToolDef[] = rawStratzTools.map((t) => ({
  ...t,
  handler: async (args, ctx) => {
    try {
      return await t.handler(args, ctx);
    } catch (err) {
      return stratzErrorResult(err);
    }
  },
}));

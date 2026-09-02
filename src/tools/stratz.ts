import { z } from "zod";
import { apiGet } from "../client.js";
import { getAbilityIds, getHeroAbilities } from "../constants.js";
import { heroRef, itemRef, abilityRef } from "../mapping.js";
import { getLocaleBundle } from "../locales.js";
import { sampleFields } from "../stats.js";
import { stratzQuery, StratzApiError } from "../stratz.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";
import { resolveHero, stripPlaceholders } from "./reference.js";

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

const BRACKET_LABEL: Record<string, string> = {
  herald_guardian: "Herald–Guardian (low)",
  crusader_archon: "Crusader–Archon (mid-low)",
  legend_ancient: "Legend–Ancient (mid-high)",
  divine_immortal: "Divine–Immortal (high)",
};

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
    return { error: `Unknown hero: ${input}`, hint: "Resolve names to ids with search_dota_entities first." };
  }
  return id;
}

function wr(games: number, wins: number) {
  return { games, win_rate_pct: pct(wins, games), ...sampleFields(games, wins) };
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
      "each with games, win rate and a 95% confidence interval. Source: stratz.com; requires STRATZ_API_TOKEN.",
    schema: {
      hero: heroArg,
      bracket: bracketArg,
      take: z.number().int().min(3).max(20).optional().describe("Rows per list (default 10)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHeroId(args.hero, lang);
      if (typeof heroId === "object") return heroId;
      const take = args.take ?? 10;
      const data = await stratzQuery<{ heroStats: { heroVsHeroMatchup: { advantage: { vs: PairRow[] }[]; disadvantage: { vs: PairRow[] }[] } | null } }>(
        "heroVsHeroMatchup",
        `query { heroStats { heroVsHeroMatchup(heroId: ${heroId}${bracketFilter(args.bracket)}, take: 50) ` +
          `{ advantage { heroId vs { heroId2 matchCount winCount } } disadvantage { heroId vs { heroId2 matchCount winCount } } } } }`,
      );
      const mu = data?.heroStats?.heroVsHeroMatchup;
      const pairs = new Map<number, PairRow>();
      for (const p of [...(mu?.advantage?.[0]?.vs ?? []), ...(mu?.disadvantage?.[0]?.vs ?? [])]) {
        if (p.heroId2 !== heroId && (!pairs.has(p.heroId2) || p.matchCount > pairs.get(p.heroId2)!.matchCount)) {
          pairs.set(p.heroId2, p);
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
        recommendations,
        note: "Candidates ranked by how many enemies they beat (>= 30 games per matchup); win rates are the candidate's, from the enemy's disadvantage pairs.",
        source: "stratz.com",
      };
    },
  },
  {
    name: "get_draft_composition",
    description:
      "TEAM COMPOSITION analysis at coach level, from STRATZ per-hero aggregates + OpenDota duration curves: " +
      "damage mix (physical vs magical share), control/healing/push distribution, gold dependency, and each " +
      "lineup's early/mid/late win-rate windows, then data-backed coaching notes (e.g. 'enemy damage is 78% " +
      "magical — Pipe/BKB priority', 'their control sits on one hero', 'you outscale them: avoid fights " +
      "before 30 min'). Pair with get_draft_advice (counter picks) for full draft guidance. " +
      "Sources: stratz.com + opendota durations; requires STRATZ_API_TOKEN.",
    schema: {
      team_heroes: z.array(heroArg).min(1).max(5).describe("Your lineup (hero ids or names)."),
      enemy_heroes: z.array(heroArg).max(5).optional().describe("Enemy lineup, for comparison notes."),
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

      const [statsResp, durationLists] = await Promise.all([
        stratzQuery<{ heroStats: { stats: StatRow[] | undefined } }>(
          "statsAggregate",
          `query { heroStats { stats(heroIds: [${allIds.join(",")}]${bracketFilter(args.bracket)}) ` +
            `{ heroId matchCount winCount heroDamage physicalDamage magicalDamage towerDamage disableDuration healingAllies networth } } }`,
        ),
        Promise.all(
          allIds.map((id) =>
            apiGet<{ duration_bin: number; games_played: number; wins: number }[]>(`/heroes/${id}/durations`, { ttl: "constants" }).catch(() => []),
          ),
        ),
      ]);
      const statById = new Map((statsResp?.heroStats?.stats ?? []).map((r) => [r.heroId ?? -1, r]));
      const durById = new Map(allIds.map((id, i) => [id, durationLists[i] ?? []]));

      const timing = (id: number) => {
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
      };

      const compose = async (ids: number[]) => {
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
            const t = timing(id);
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
              timing: t,
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
          _topControlHero: controlShares[0]?.id,
        };
      };

      const yours = await compose(teamIds);
      const enemy = enemyIds.length ? await compose(enemyIds) : undefined;
      const nameOf = async (id: number) => (await heroRef(id, lang))?.name ?? `hero ${id}`;

      const notes: string[] = [];
      const tgt = enemy ?? yours;
      if (tgt.totals.magical_damage_pct >= 70)
        notes.push(`${enemy ? "Enemy" : "Your"} damage is ${tgt.totals.magical_damage_pct}% magical — ${enemy ? "Pipe/BKB/immunity items are high priority for you" : "expect Pipe/BKB against you; consider physical damage sources"}.`);
      if (tgt.totals.physical_damage_pct >= 70)
        notes.push(`${enemy ? "Enemy" : "Your"} damage is ${tgt.totals.physical_damage_pct}% physical — ${enemy ? "armor/Blade Mail/Ghost Scepter gain value" : "expect armor stacking against you"}.`);
      if ((tgt.totals.control_top1_pct ?? 0) >= 50 && tgt._topControlHero != null)
        notes.push(`${enemy ? "Enemy" : "Your"} control is ${tgt.totals.control_top1_pct}% concentrated on one hero (${await nameOf(tgt._topControlHero)}) — ${enemy ? "banning/killing/focusing them in fights removes most of their setup" : "protect that hero's initiations"}.`);
      if (enemy) {
        const d = (a?: number, b?: number) => (a != null && b != null ? a - b : undefined);
        const lateD = d(yours.totals.late_win_rate_pct, enemy.totals.late_win_rate_pct);
        const earlyD = d(enemy.totals.early_win_rate_pct, yours.totals.early_win_rate_pct);
        if (lateD != null && lateD >= 4)
          notes.push(`You outscale them (late ${yours.totals.late_win_rate_pct}% vs ${enemy.totals.late_win_rate_pct}%) — avoid forced fights before 30 min, trade space for time.`);
        else if (lateD != null && lateD <= -4)
          notes.push(`They outscale you (late ${enemy.totals.late_win_rate_pct}% vs ${yours.totals.late_win_rate_pct}%) — force the tempo, end before 40 min, take early objectives.`);
        if (earlyD != null && earlyD >= 4)
          notes.push(`Enemy is strongest early (early ${enemy.totals.early_win_rate_pct}% vs ${yours.totals.early_win_rate_pct}%) — defensive wards, avoid early rotations, weather the storm.`);
        const enemyHeal = enemy.totals.team_healing ?? 0;
        const yourHeal = yours.totals.team_healing ?? 0;
        if (enemyHeal > 1000 && yourHeal < enemyHeal / 5)
          notes.push(`Enemy sustain is heavy (healing ${Math.round(enemyHeal)} vs your ${Math.round(yourHeal)}) — Spirit Vessel / Shiva's / burst damage gain a lot of value.`);
      }
      const nw = yours.heroes.map((h) => h.avg_networth ?? 0);
      if (nw.length > 1 && Math.max(...nw) > 0 && Math.min(...nw) > 0 && Math.max(...nw) / Math.min(...nw) > 1.6)
        notes.push(`Gold dependency is uneven (networth spread ${Math.round(Math.min(...nw))}-${Math.round(Math.max(...nw))}) — the low-income cores need space or cheap power spikes.`);

      return {
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
        yours: { heroes: yours.heroes, totals: yours.totals },
        ...(enemy ? { enemy: { heroes: enemy.heroes, totals: enemy.totals } } : {}),
        coach_notes: notes,
        note: "Shares are within-lineup relative (STRATZ raw per-game values; absolute units undocumented). Timing windows use OpenDota duration curves, all brackets. Use get_draft_advice for counter picks on top of this.",
        source: "stratz.com + opendota",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
        bracket: args.bracket ? BRACKET_LABEL[args.bracket] : "all brackets",
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
          { ttlMs: 60 * 60_000 },
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
        bracket: args.bracket ?? "all brackets",
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

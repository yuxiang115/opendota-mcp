import { z } from "zod";
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

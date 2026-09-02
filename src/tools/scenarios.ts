import { z } from "zod";
import { apiGet } from "../client.js";
import { getItemIds, getItems } from "../constants.js";
import { lookupItemAlias } from "../aliases.js";
import { getLocaleBundle } from "../locales.js";
import { abilityRef, laneRoleLabel, rankTierToLabel } from "../mapping.js";
import { itemInternalRef } from "../enrich.js";
import { sampleFields } from "../stats.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

const heroIdParam = z
  .number()
  .int()
  .positive()
  .describe("Hero id (resolve names with search_dota_entities first).");

/** Resolve an item reference (numeric id / internal name / English or localized display name / community nickname) to its item id. */
async function resolveItemIdInput(input: number | string, lang = "english"): Promise<number | undefined> {
  if (typeof input === "number") return input;
  const q = input.trim().toLowerCase();
  const itemIds = await getItemIds();
  const items = await getItems();
  const localItems = getLocaleBundle(lang).items;
  const idByInternal = new Map<string, number>();
  for (const [id, internal] of Object.entries(itemIds)) {
    if (String(internal).toLowerCase() === q) return Number(id);
    idByInternal.set(String(internal), Number(id));
  }
  // Official localized display names (魂之灵瓮, 闪烁匕首, ...) — previously unmatchable.
  for (const entry of Object.values(localItems)) {
    if (entry.name && entry.name.toLowerCase() === q) {
      const id = idByInternal.get(entry.internal);
      if (id != null) return id;
    }
  }
  // Community nicknames (大骨灰, 跳刀, bkb, ...).
  const aliasInternal = lookupItemAlias(q);
  if (aliasInternal) {
    const id = idByInternal.get(aliasInternal);
    if (id != null) return id;
  }
  const dnameMatches = Object.entries(itemIds).filter(
    ([, internal]) => String(items[String(internal)]?.dname ?? "").toLowerCase() === q,
  );
  if (dnameMatches.length === 1) return Number(dnameMatches[0][0]);
  const partial = Object.entries(itemIds).filter(([, internal]) =>
    String(items[String(internal)]?.dname ?? "").toLowerCase().includes(q),
  );
  return partial.length === 1 ? Number(partial[0][0]) : undefined;
}

function winRate(wins: number, games: number): number {
  return Math.round((wins / games) * 1000) / 10;
}

export const scenarioTools: ToolDef[] = [
  {
    name: "get_item_timing_stats",
    description:
      "Win rates by ITEM TIMING for a hero, from public scenario stats: e.g. 'PA with Battle Fury " +
      "before minute 8 wins 63% (27 games)'. Use this to answer when a hero should have which item, " +
      "and whether a given timing was early/late. Small-sample rows (under min_games) are dropped. " +
      "Aggregated across ALL rank brackets (the scenario source no longer accepts rank filters).",
    schema: {
      hero_id: heroIdParam,
      min_games: z.number().int().min(1).optional().describe("Min sample size per row (default 10)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const rows = await apiGet<{ hero_id: number; item: string; time: number; games: number; wins: number }[]>(
        "/scenarios/itemTimings",
        { query: { hero_id: args.hero_id }, ttl: "aggregate" },
      );
      const minGames = args.min_games ?? 10;
      const byBucket = new Map<string, { item: string; name: string; games: number; wins: number }[]>();
      for (const r of rows) {
        if (r.games < minGames) continue;
        const bucket = `before ${Math.round(r.time / 60)} min`;
        const list = byBucket.get(bucket) ?? [];
        list.push({ item: r.item, name: "", games: r.games, wins: r.wins });
        byBucket.set(bucket, list);
      }
      const out: Record<string, unknown> = {};
      let totalGames = 0;
      for (const [bucket, list] of byBucket) {
        out[bucket] = await Promise.all(
          list
            .sort((a, b) => b.games - a.games)
            .map(async (e) => {
              totalGames += e.games;
              const ref = await itemInternalRef(e.item, lang);
              return {
                item: ref?.name ?? e.item,
                games: e.games,
                win_rate_pct: winRate(e.wins, e.games),
                ...sampleFields(e.games, e.wins),
              };
            }),
        );
      }
      return { hero_id: args.hero_id, min_games: minGames, timings: out };
    },
  },
  {
    name: "get_lane_role_stats",
    description:
      "Win rate of a hero per LANE ROLE and GAME LENGTH bucket from public scenario stats — shows " +
      "which lane the hero performs in and whether it wants short or long games (e.g. 'PA in safe " +
      "lane under 15 min: 32% — she loses fast games'). Complements get_hero_matchups (hero-vs-hero). " +
      "Aggregated across ALL rank brackets.",
    schema: {
      hero_id: heroIdParam,
      min_games: z.number().int().min(1).optional().describe("Min sample size per row (default 5)."),
    },
    handler: async (args) => {
      const rows = await apiGet<{ hero_id: number; lane_role: number; time: number; games: number; wins: number }[]>(
        "/scenarios/laneRoles",
        { query: { hero_id: args.hero_id }, ttl: "aggregate" },
      );
      const minGames = args.min_games ?? 5;
      return {
        hero_id: args.hero_id,
        rows: rows
          .filter((r) => r.games >= minGames)
          .sort((a, b) => a.time - b.time || b.games - a.games)
          .map((r) => ({
            lane_role: laneRoleLabel(r.lane_role),
            game_length: `under ${Math.round(r.time / 60)} min`,
            games: r.games,
            win_rate_pct: winRate(r.wins, r.games),
            ...sampleFields(r.games, r.wins),
          })),
      };
    },
  },
  {
    name: "get_public_matches",
    description:
      "Live feed of recent public matches by rank bracket (10=Herald .. 80=Immortal), with both " +
      "teams' heroes resolved to names. Use for meta sampling: what is being picked right now at a " +
      "given rank, and who is winning.",
    schema: {
      min_rank: z.number().int().min(10).max(80).optional().describe("Min rank bracket (10 Herald .. 80 Immortal)."),
      max_rank: z.number().int().min(10).max(80).optional().describe("Max rank bracket."),
      limit: z.number().int().min(1).max(100).optional().describe("Max matches (default 20)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const rows = await apiGet<
        {
          match_id: number; radiant_win: boolean; duration: number; start_time: number;
          avg_rank_tier: number; radiant_team: number[]; dire_team: number[];
        }[]
      >("/publicMatches", { query: { min_rank: args.min_rank, max_rank: args.max_rank }, ttl: "listing", noCache: true });
      const limit = args.limit ?? 20;
      const heroRefLazy = (await import("../mapping.js")).heroRef;
      const named = await Promise.all(
        rows.slice(0, limit).map(async (m) => {
          const rawIds = [...(m.radiant_team ?? []), ...(m.dire_team ?? [])];
          // The live feed reports hero id 0 until the match is parsed; skip picks in that case.
          const picksKnown = rawIds.some((id) => id > 0);
          const resolve = async (ids: number[]) =>
            (await Promise.all(ids.filter((id) => id > 0).map((id) => heroRefLazy(id, lang))))
              .map((r) => r?.name)
              .filter(Boolean);
          return {
            match_id: m.match_id,
            avg_rank: rankTierToLabel(m.avg_rank_tier, undefined, lang),
            avg_rank_tier_raw: m.avg_rank_tier,
            duration_seconds: m.duration,
            radiant_win: m.radiant_win,
            ...(picksKnown
              ? { radiant_picks: await resolve(m.radiant_team ?? []), dire_picks: await resolve(m.dire_team ?? []) }
              : { note: "hero ids not yet available (unparsed feed rows)" }),
          };
        }),
      );
      return { matches: named };
    },
  },
  {
    name: "get_skill_builds",
    description:
      "Most popular SKILL BUILD orders (加点) for a hero over the last N days, aggregated by SQL " +
      "from parsed matches: the first levels' upgrade order with games and win rate, ability names " +
      "resolved. Use this instead of guessing skill orders from memory. Note the sample is parsed " +
      "matches only (no rank-bracket filter available) — check the sample size before drawing conclusions.",
    schema: {
      hero_id: heroIdParam,
      days: z.number().int().min(7).max(365).optional().describe("Lookback window in days (default 90)."),
      levels: z.number().int().min(4).max(18).optional().describe("How many first levels to aggregate (default 6)."),
      min_games: z.number().int().min(1).optional().describe("Min sample per build (default 3)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const days = args.days ?? 90;
      const levels = args.levels ?? 6;
      const minGames = args.min_games ?? 3;
      const sql = `SELECT pm.ability_upgrades_arr[0:${levels}] AS build, count(*) AS games, ` +
        `sum(CASE WHEN m.radiant_win = (pm.player_slot < 128) THEN 1 ELSE 0 END) AS wins ` +
        `FROM player_matches pm JOIN matches m ON pm.match_id = m.match_id ` +
        `WHERE pm.hero_id = ${args.hero_id} AND pm.ability_upgrades_arr IS NOT NULL ` +
        `AND m.start_time > extract(epoch from now()) - ${days * 86400} ` +
        `GROUP BY 1 ORDER BY games DESC LIMIT 10`;
      const res = await apiGet<{ rows?: { build: number[]; games: number; wins: number }[] }>(
        "/explorer",
        { query: { sql }, ttl: "aggregate", timeoutMs: 20_000 },
      );
      const rows = res.rows ?? [];
      const totalGames = rows.reduce((s, r) => s + Number(r.games), 0);
      const builds = await Promise.all(
        rows.filter((r) => Number(r.games) >= minGames).map(async (r) => ({
          order: (await Promise.all((r.build ?? []).map((id) => abilityRef(id, lang))))
            .map((a) => a?.name)
            .filter(Boolean),
          games: Number(r.games),
          win_rate_pct: winRate(Number(r.wins), Number(r.games)),
        })),
      );
      return {
        hero_id: args.hero_id,
        days,
        levels,
        total_parsed_games_sampled: totalGames,
        builds,
        note: "Sample = parsed public matches only; niche heroes may have few games.",
      };
    },
  },
  {
    name: "get_hero_synergy",
    description:
      "ALLY synergy for a hero: win rates of hero pairings on the SAME team ('PA + Earthshaker: " +
      "62% over 40 games'), aggregated by SQL from parsed public matches. Without ally_hero_id it " +
      "returns the best and worst common allies. This is the same-team counterpart of " +
      "get_hero_matchups (enemies). Sample = parsed matches only, no rank-bracket filter — " +
      "always check games before trusting a percentage.",
    schema: {
      hero_id: heroIdParam,
      ally_hero_id: z.number().int().positive().optional().describe("Restrict to one ally hero."),
      days: z.number().int().min(30).max(365).optional().describe("Lookback window (default 180 — synergy needs a wide sample)."),
      min_games: z.number().int().min(1).optional().describe("Min games per pair (default 5)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const days = args.days ?? 180;
      const minGames = args.min_games ?? 5;
      const heroRefLazy = (await import("../mapping.js")).heroRef;
      const base =
        "FROM player_matches a JOIN player_matches b ON a.match_id = b.match_id " +
        "AND (a.player_slot < 128) = (b.player_slot < 128) AND a.player_slot <> b.player_slot " +
        `JOIN matches m ON a.match_id = m.match_id WHERE a.hero_id = ${args.hero_id} ` +
        `AND m.start_time > extract(epoch from now()) - ${days * 86400}`;
      if (args.ally_hero_id != null) {
        const sql = `SELECT count(*) AS games, sum(CASE WHEN m.radiant_win = (a.player_slot < 128) THEN 1 ELSE 0 END) AS wins ${base} AND b.hero_id = ${args.ally_hero_id}`;
        const res = await apiGet<{ rows?: { games: number; wins: number }[] }>("/explorer", { query: { sql }, ttl: "aggregate", timeoutMs: 20_000 });
        const r = res.rows?.[0];
        const games = Number(r?.games ?? 0);
        const [h1, h2] = await Promise.all([heroRefLazy(args.hero_id, lang), heroRefLazy(args.ally_hero_id, lang)]);
        return {
          pair: [h1?.name, h2?.name],
          games,
          win_rate_pct: games > 0 ? winRate(Number(r?.wins ?? 0), games) : undefined,
          days,
          note: games < minGames ? "Sample too small for conclusions." : undefined,
        };
      }
      const sql =
        `SELECT b.hero_id AS ally, count(*) AS games, sum(CASE WHEN m.radiant_win = (a.player_slot < 128) THEN 1 ELSE 0 END) AS wins ` +
        `${base} GROUP BY 1 HAVING count(*) >= ${minGames} ORDER BY 2 DESC LIMIT 300`;
      const res = await apiGet<{ rows?: { ally: number; games: number; wins: number }[] }>("/explorer", { query: { sql }, ttl: "aggregate", timeoutMs: 25_000 });
      const rows = (res.rows ?? []).map((r) => ({
        ally: Number(r.ally),
        games: Number(r.games),
        win_rate_pct: winRate(Number(r.wins), Number(r.games)),
        ...sampleFields(Number(r.games), Number(r.wins)),
      }));
      const withNames = await Promise.all(rows.map(async (r) => ({ ...r, ally: (await heroRefLazy(r.ally, lang))?.name ?? r.ally })));
      const ranked = withNames.sort((a, b) => b.win_rate_pct - a.win_rate_pct);
      return {
        hero_id: args.hero_id,
        days,
        min_games: minGames,
        pairs_sampled: ranked.length,
        best_allies: ranked.slice(0, 5),
        worst_allies: ranked.slice(-5).reverse(),
      };
    },
  },
  {
    name: "get_item_winrate_vs_hero",
    description:
      "Item win rate for a hero AGAINST one specific enemy hero — the cross-tab neither get_item_builds_by_rank " +
      "(no enemy filter) nor get_hero_matchups (no items) can slice. With `item` it returns the with/without " +
      "comparison: 'Ember with Spirit Vessel vs Necrophos: 52.8% (248 games) vs 46.2% without (+6.6pp)'. " +
      "Without `item` it lists the hero's most common final-build items in this matchup with win rates. " +
      "Based on the final six inventory slots of parsed public matches (OpenDota SQL) — no purchase timing; " +
      "use get_item_builds_by_rank for timing/aggregated builds. Quote win rates with their ci95_pp.",
    schema: {
      hero_id: heroIdParam,
      enemy_hero_id: z.number().int().positive().describe("The opposing hero id (resolve names with search_dota_entities first)."),
      item: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Item id, internal name ('spirit_vessel'), display name ('Spirit Vessel'/'魂之灵瓮') or community nickname ('大骨灰', 'bkb'). Omit to list common final-build items."),
      days: z.number().int().min(30).max(720).optional().describe("Lookback window in days (default 180)."),
      min_games: z.number().int().min(1).optional().describe("Min games per row when listing items (default 20)."),
      limit: z.number().int().min(3).max(20).optional().describe("Max item rows when listing (default 10)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const days = args.days ?? 180;
      const { heroRef, itemRef } = await import("../mapping.js");
      const winsExpr = "CASE WHEN m.radiant_win = (a.player_slot < 128) THEN 1 ELSE 0 END";
      const slotList = "a.item_0, a.item_1, a.item_2, a.item_3, a.item_4, a.item_5";
      const timeFilter = `m.start_time > extract(epoch from now()) - ${days * 86400}`;

      if (args.item != null) {
        const itemId = await resolveItemIdInput(args.item, lang);
        if (itemId == null) {
          return {
            error: `Unknown item: ${args.item}`,
            hint: "Resolve item names with search_dota_entities, or pass the numeric item id or internal name (it also knows community nicknames like 大骨灰/跳刀/bkb).",
          };
        }
        const q = (withItem: boolean) =>
          `SELECT count(*) AS games, sum(${winsExpr}) AS wins FROM player_matches a ` +
          "JOIN player_matches b ON a.match_id = b.match_id AND (a.player_slot < 128) <> (b.player_slot < 128) " +
          `JOIN matches m ON a.match_id = m.match_id WHERE a.hero_id = ${args.hero_id} AND b.hero_id = ${args.enemy_hero_id} ` +
          `AND ${timeFilter} AND ${itemId} ${withItem ? "IN" : "NOT IN"} (${slotList})`;
        const [wRes, woRes] = await Promise.all([
          apiGet<{ rows?: { games: number; wins: number }[] }>("/explorer", { query: { sql: q(true) }, ttl: "aggregate", timeoutMs: 25_000 }),
          apiGet<{ rows?: { games: number; wins: number }[] }>("/explorer", { query: { sql: q(false) }, ttl: "aggregate", timeoutMs: 25_000 }),
        ]);
        const w = wRes.rows?.[0] ?? { games: 0, wins: 0 };
        const wo = woRes.rows?.[0] ?? { games: 0, wins: 0 };
        const withWr = winRate(Number(w.wins), Number(w.games));
        const withoutWr = winRate(Number(wo.wins), Number(wo.games));
        const [hero, enemy, ref] = await Promise.all([
          heroRef(args.hero_id, lang),
          heroRef(args.enemy_hero_id, lang),
          itemRef(itemId, lang),
        ]);
        return {
          hero: hero?.name,
          enemy: enemy?.name,
          item: ref?.name ?? `item ${itemId}`,
          days,
          with_item: { games: Number(w.games), win_rate_pct: withWr, ...sampleFields(Number(w.games), Number(w.wins)) },
          without_item: { games: Number(wo.games), win_rate_pct: withoutWr, ...sampleFields(Number(wo.games), Number(wo.wins)) },
          ...(Number(w.games) > 0 && Number(wo.games) > 0 ? { delta_pp: Math.round((withWr - withoutWr) * 10) / 10 } : {}),
          note: "Final six inventory slots of parsed public matches (correlation, not causation — better players may simply buy it more). Positive delta_pp means the item co-occurs with winning this matchup.",
          source: "opendota-explorer",
        };
      }

      const minGames = args.min_games ?? 20;
      const listSql =
        `SELECT u.item_id, count(*) AS games, sum(${winsExpr}) AS wins FROM player_matches a ` +
        "JOIN player_matches b ON a.match_id = b.match_id AND (a.player_slot < 128) <> (b.player_slot < 128) " +
        `JOIN matches m ON a.match_id = m.match_id CROSS JOIN UNNEST(ARRAY[${slotList}]) AS u(item_id) ` +
        `WHERE a.hero_id = ${args.hero_id} AND b.hero_id = ${args.enemy_hero_id} AND u.item_id > 0 AND ${timeFilter} ` +
        `GROUP BY 1 HAVING count(*) >= ${minGames} ORDER BY 2 DESC LIMIT ${args.limit ?? 10}`;
      const [listRes, baseRes] = await Promise.all([
        apiGet<{ rows?: { item_id: number; games: number; wins: number }[] }>("/explorer", { query: { sql: listSql }, ttl: "aggregate", timeoutMs: 25_000 }),
        apiGet<{ rows?: { games: number; wins: number }[] }>("/explorer", {
          query: {
            sql:
              `SELECT count(*) AS games, sum(${winsExpr}) AS wins FROM player_matches a ` +
              "JOIN player_matches b ON a.match_id = b.match_id AND (a.player_slot < 128) <> (b.player_slot < 128) " +
              `JOIN matches m ON a.match_id = m.match_id WHERE a.hero_id = ${args.hero_id} AND b.hero_id = ${args.enemy_hero_id} AND ${timeFilter}`,
          },
          ttl: "aggregate",
          timeoutMs: 25_000,
        }),
      ]);
      const base = baseRes.rows?.[0] ?? { games: 0, wins: 0 };
      const rows = await Promise.all(
        (listRes.rows ?? []).map(async (r) => {
          const ref = await itemRef(Number(r.item_id), lang);
          return {
            item: ref?.name ?? `item ${r.item_id}`,
            games: Number(r.games),
            win_rate_pct: winRate(Number(r.wins), Number(r.games)),
            ...sampleFields(Number(r.games), Number(r.wins)),
          };
        }),
      );
      const [hero, enemy] = await Promise.all([heroRef(args.hero_id, lang), heroRef(args.enemy_hero_id, lang)]);
      return {
        hero: hero?.name,
        enemy: enemy?.name,
        days,
        min_games: minGames,
        baseline: { games: Number(base.games), win_rate_pct: winRate(Number(base.wins), Number(base.games)) },
        items: rows,
        note: "Most common FINAL-build items in this matchup (final six slots, no purchase order). Compare each win_rate_pct against baseline; add a specific `item` for the with/without comparison.",
        source: "opendota-explorer",
      };
    },
  },
  {
    name: "get_explorer_schema",
    description:
      "Table/column dictionary of the public dataset behind run_explorer_query (matches, " +
      "player_matches, heroes, teams, picks_bans, public_matches, ...). Call this before writing " +
      "custom SQL so column names are correct (e.g. start_time is on matches, hero_id on player_matches).",
    schema: {
      table: z.string().optional().describe("Restrict to one table (e.g. 'player_matches')."),
    },
    handler: async (args) => {
      const schema = await apiGet<{ table_name: string; column_name: string }[]>("/schema", { ttl: "constants" });
      const filtered = args.table ? schema.filter((s) => s.table_name === args.table) : schema;
      const byTable: Record<string, string[]> = {};
      for (const s of filtered) (byTable[s.table_name] ??= []).push(s.column_name);
      return { tables: Object.fromEntries(Object.entries(byTable).map(([t, cols]) => [t, { columns: cols, column_count: cols.length }])) };
    },
  },
  {
    name: "run_explorer_query",
    description:
      "Run a read-only SQL query against OpenDota's public matches dataset (POSTGRES syntax, tables " +
      "include matches, player_matches, heroes, teams, leagues, picks_bans, public_matches — see " +
      "get_constants? Use /schema via get_api_health first if unsure). For custom aggregations the " +
      "dedicated tools don't cover. ALWAYS include a LIMIT (results are truncated at ~500KB). " +
      "start_time lives on matches, hero/player fields on player_matches (join on match_id). " +
      "Example: SELECT pm.hero_id, count(*) FROM player_matches pm JOIN matches m ON pm.match_id = m.match_id " +
      "WHERE m.start_time > extract(epoch from now()) - 86400 GROUP BY 1 ORDER BY 2 DESC LIMIT 5.",
    schema: {
      sql: z.string().min(8).describe("SELECT query. Include LIMIT; writes are rejected server-side."),
    },
    handler: async (args) => {
      const res = await apiGet<Record<string, any>>("/explorer", {
        query: { sql: args.sql },
        ttl: "aggregate",
        timeoutMs: 20_000,
      });
      if (res?.error) return { error: String(res.error), hint: "Check table/column names via the /schema endpoint." };
      const rows = (res?.rows ?? []) as Record<string, unknown>[];
      const rowCount = res?.rowCount ?? rows.length;
      const MAX_BYTES = 500 * 1024;
      let payload = rows;
      let truncated = false;
      if (JSON.stringify(rows).length > MAX_BYTES) {
        while (payload.length > 0 && JSON.stringify(payload).length > MAX_BYTES) payload = payload.slice(0, Math.floor(payload.length / 2));
        truncated = true;
      }
      return {
        rowCount,
        returned: payload.length,
        truncated,
        ...(truncated ? { hint: "Result truncated — add a tighter WHERE or smaller LIMIT." } : {}),
        rows: payload,
      };
    },
  },
];

import { z } from "zod";
import { apiGet } from "../client.js";
import { abilityRef, laneRoleLabel } from "../mapping.js";
import { itemInternalRef } from "../enrich.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

const heroIdParam = z
  .number()
  .int()
  .positive()
  .describe("Hero id (resolve names with search_dota_entities first).");

function winRate(wins: number, games: number): number {
  return Math.round((wins / games) * 1000) / 10;
}

export const scenarioTools: ToolDef[] = [
  {
    name: "get_item_timing_stats",
    description:
      "Win rates by ITEM TIMING for a hero, from public scenario stats: e.g. 'PA with Battle Fury " +
      "before minute 8 wins 63% (27 games)'. Use this to answer when a hero should have which item, " +
      "and whether a given timing was early/late. Small-sample rows (under min_games) are dropped.",
    schema: {
      hero_id: heroIdParam,
      min_games: z.number().int().min(1).optional().describe("Min sample size per row (default 10)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const rows = await apiGet<{ hero_id: number; item: string; time: number; games: number; wins: number }[]>(
        "/scenarios/itemTimings",
        { query: { hero_id: args.hero_id }, ttl: "constants" },
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
              return { item: ref?.name ?? e.item, games: e.games, win_rate_pct: winRate(e.wins, e.games) };
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
      "lane under 15 min: 32% — she loses fast games'). Complements get_hero_matchups (hero-vs-hero).",
    schema: {
      hero_id: heroIdParam,
      min_games: z.number().int().min(1).optional().describe("Min sample size per row (default 5)."),
    },
    handler: async (args) => {
      const rows = await apiGet<{ hero_id: number; lane_role: number; time: number; games: number; wins: number }[]>(
        "/scenarios/laneRoles",
        { query: { hero_id: args.hero_id }, ttl: "constants" },
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
            avg_rank_tier: m.avg_rank_tier,
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
      "matches only — check the sample size before drawing conclusions.",
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
        { query: { sql }, ttl: "listing", timeoutMs: 20_000 },
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
        ttl: "listing",
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

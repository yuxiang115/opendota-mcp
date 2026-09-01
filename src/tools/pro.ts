import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichPlayerMatchRow, formatDuration, heroRef, rankTierToLabel } from "../mapping.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

export const proTools: ToolDef[] = [
  {
    name: "get_pro_matches",
    description:
      "Most recent professional matches (league, teams, score, duration), newest first. " +
      "Paginate with less_than_match_id. Enriched with readable fields.",
    schema: {
      language: languageParam,
      less_than_match_id: z
        .number()
        .int()
        .optional()
        .describe("Return older matches only (pass the last match_id of the previous page)."),
      limit: z.number().int().min(1).max(100).optional().describe("Max matches to return (default 20)."),
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>("/proMatches", {
        query: { less_than_match_id: args.less_than_match_id },
        ttl: "listing",
        noCache: true,
      });
      const lang = effectiveLanguage(args.language, ctx);
      const limited = rows.slice(0, args.limit ?? 20);
      return Promise.all(limited.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_pro_players",
    description: "List of professional players with their teams, countries and Steam ids.",
    schema: {},
    handler: async () => {
      return apiGet("/proPlayers", { ttl: "listing" });
    },
  },
  {
    name: "get_leagues",
    description: "All tracked leagues/tournaments with ids and tiers (professional, premium, ...).",
    schema: {},
    handler: async () => {
      return apiGet("/leagues", { ttl: "listing" });
    },
  },
  {
    name: "get_league_matches",
    description: "Matches played in a league/tournament, enriched. Use get_leagues to find league ids.",
    schema: {
      league_id: z.number().int().positive().describe("League id."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/leagues/${args.league_id}/matches`, { ttl: "match" });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(rows.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_live_matches",
    description:
      "Top live games currently in progress (average rank, spectate count, scoreboard) with hero names.",
    schema: {
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>("/live", { ttl: "listing", noCache: true });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(
        rows.slice(0, 20).map(async (row) => {
          const players = await Promise.all(
            (row.players ?? []).map(async (p: Record<string, any>) => ({
              account_id: p.account_id,
              personaname: p.personaname,
              hero: await heroRef(p.hero_id, lang),
              is_radiant: (p.team ?? p.player_slot) === 2 || (p.player_slot ?? 0) < 128,
              kills: p.kills,
              deaths: p.deaths,
              assists: p.assists,
            })),
          );
          return {
            match_id: row.match_id,
            activate_time: row.activate_time,
            deactivate_time: row.deactivate_time,
            game_time: formatDuration(row.game_time),
            game_time_seconds: row.game_time,
            spectators: row.spectators,
            average_rank: row.average_rank_tier ? rankTierToLabel(row.average_rank_tier) : undefined,
            league_id: row.leagueid,
            radiant_lead: row.radiant_lead,
            radiant_score: row.radiant_score,
            dire_score: row.dire_score,
            players,
          };
        }),
      );
    },
  },
];

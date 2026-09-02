import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichPlayerMatchRow, heroRef } from "../mapping.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

const teamIdParam = z.number().int().positive().describe("Team id (from get_teams, pro match rows, or get_pro_players).");

export const teamTools: ToolDef[] = [
  {
    name: "get_teams",
    description: "List professional teams ranked by rating, with wins/losses and recent ratings.",
    schema: {
      page: z.number().int().min(0).optional().describe("Zero-indexed page; each page has up to 1000 teams."),
    },
    handler: async (args) => {
      return apiGet("/teams", { query: { page: args.page }, ttl: "player" });
    },
  },
  {
    name: "get_team",
    description: "Get one professional team's profile (rating, wins/losses, logo, tags).",
    schema: {
      team_id: teamIdParam,
    },
    handler: async (args) => {
      return apiGet(`/teams/${args.team_id}`, { ttl: "player" });
    },
  },
  {
    name: "get_team_matches",
    description: "A pro team's recent matches, enriched with hero names for both sides and game mode labels.",
    schema: {
      team_id: teamIdParam,
      language: languageParam,
      limit: z.number().int().min(1).max(100).optional().describe("Max matches to return."),
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/teams/${args.team_id}/matches`, { ttl: "player" });
      const lang = effectiveLanguage(args.language, ctx);
      const limited = args.limit ? rows.slice(0, args.limit) : rows;
      return Promise.all(limited.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_team_players",
    description: "Players who played for a team, with games played, wins, and current-member flag.",
    schema: {
      team_id: teamIdParam,
    },
    handler: async (args) => {
      return apiGet(`/teams/${args.team_id}/players`, { ttl: "player" });
    },
  },
  {
    name: "get_team_heroes",
    description: "Heroes a pro team plays most, with games, wins and win rates.",
    schema: {
      team_id: teamIdParam,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/teams/${args.team_id}/heroes`, { ttl: "player" });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(
        rows.map(async (row) => {
          const games = (row.games_played ?? row.games ?? 0) as number;
          const wins = (row.wins ?? row.win ?? 0) as number;
          return {
            hero: await heroRef(row.hero_id, lang),
            games_played: games,
            wins,
            win_rate_pct: games > 0 ? Math.round((wins / games) * 1000) / 10 : undefined,
          };
        }),
      );
    },
  },
];

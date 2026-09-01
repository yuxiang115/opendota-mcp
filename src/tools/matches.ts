import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichMatch } from "../enrich.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

const INCLUDE_DESCRIPTIONS = {
  teamfights: "Per-teamfight breakdown (times, deaths, damage, gold/xp deltas).",
  objectives: "Roshan/tower/ward kill events.",
  chat: "Full in-match chat log.",
  graphs: "Radiant gold/xp advantage per minute arrays.",
  draft_timings: "Captain's Mode draft timing details.",
  player_logs: "Per-player purchase/kills/ward/rune logs and ability usage counts (large).",
  benchmarks: "Per-player benchmark percentiles.",
} as const;

export const matchTools: ToolDef[] = [
  {
    name: "get_match",
    description:
      "Get a Dota 2 match by id as a compact, human-readable view: heroes/items/abilities resolved to names, " +
      "game mode/lobby/skill/region as labels, per-player KDA/GPM/XPM/items, and optional pick-ban draft. " +
      "Works with parsed matches too ( richer item/ability data when available).",
    schema: {
      match_id: z.number().int().positive().describe("Match id (from pro matches, player history, or a Dota 2 share URL)."),
      language: languageParam,
      include: z
        .object({
          picks_bans: z.boolean().optional().default(true).describe("Draft pick/ban order with hero names (default true)."),
          teamfights: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.teamfights),
          objectives: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.objectives),
          chat: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.chat),
          graphs: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.graphs),
          draft_timings: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.draft_timings),
          player_logs: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.player_logs),
          benchmarks: z.boolean().optional().default(false).describe(INCLUDE_DESCRIPTIONS.benchmarks),
        })
        .optional()
        .describe("Optional detail sections to include beyond the default compact view."),
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const match = await apiGet<Record<string, any>>(`/matches/${args.match_id}`, { ttl: "match" });
      const include = args.include ?? {};
      return enrichMatch(match, lang, {
        picks_bans: include.picks_bans ?? true,
        teamfights: include.teamfights ?? false,
        objectives: include.objectives ?? false,
        chat: include.chat ?? false,
        graphs: include.graphs ?? false,
        draft_timings: include.draft_timings ?? false,
        player_logs: include.player_logs ?? false,
        benchmarks: include.benchmarks ?? false,
      });
    },
  },
  {
    name: "request_match_parse",
    description:
      "Submit a match for full replay parsing by OpenDota (needed for deep data like chat, ward logs, teamfights " +
      "when a match is not yet parsed). Counts as 10 API calls for rate limiting. Poll get_parse_job_status with the job id.",
    schema: {
      match_id: z.number().int().positive().describe("Match id to parse."),
    },
    handler: async (args) => {
      return apiGet(`/request/${args.match_id}`, { method: "POST", rateCost: 10 });
    },
  },
  {
    name: "get_parse_job_status",
    description: "Check the status of a match parse job submitted via request_match_parse.",
    schema: {
      job_id: z.string().describe("Job id returned by request_match_parse."),
    },
    handler: async (args) => {
      return apiGet(`/request/${encodeURIComponent(args.job_id)}`, { ttl: "listing" });
    },
  },
];

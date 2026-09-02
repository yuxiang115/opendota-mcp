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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const matchTools: ToolDef[] = [
  {
    name: "get_match",
    description:
      "Get a Dota 2 match by id as a compact, human-readable view: heroes/items/abilities resolved to names, " +
      "game mode/lobby/skill/region as labels, per-player position 1-5 estimate (from lane + farm order), " +
      "KDA/GPM/XPM/items, and optional pick-ban draft. Works with parsed matches too ( richer item/ability " +
      "data when available).",
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
      "Submit a match for full replay parsing and WAIT for it to finish (default 45s). Unparsed matches lack " +
      "teamfights/graphs/ward logs; once parsed, call get_match with include.teamfights for the deep view. " +
      "Counts as 10 API calls. If status comes back unfinished, retry later or poll with get_parse_job_status.",
    schema: {
      match_id: z.number().int().positive().describe("Match id to parse."),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe("How long to poll for completion before returning (default 45, must stay under your MCP client timeout)."),
    },
    handler: async (args) => {
      const submitted = await apiGet<{ job?: { jobId?: number | string } }>(`/request/${args.match_id}`, {
        method: "POST",
        rateCost: 10,
      });
      const jobId = submitted?.job?.jobId != null ? String(submitted.job.jobId) : undefined;
      const waitMs = (args.wait_seconds ?? 45) * 1000;
      if (waitMs === 0) {
        return { job_id: jobId, status: "submitted", note: "Poll with get_parse_job_status or re-call this tool with wait_seconds." };
      }
      const deadline = Date.now() + waitMs;
      let verifiedOnce = false;
      while (Date.now() < deadline) {
        await sleep(5000);
        let job: unknown = null;
        try {
          job = await apiGet(`/request/${jobId}`, { ttl: "listing", noCache: true });
        } catch {
          job = null;
        }
        if (job && typeof job === "object" && Object.keys(job as object).length > 0) {
          continue; // still queued/processing; keep waiting
        }
        // OpenDota returns null/empty for finished-and-cleaned jobs — verify via the match itself (once).
        if (!verifiedOnce) {
          verifiedOnce = true;
          try {
            const m = await apiGet<Record<string, any>>(`/matches/${args.match_id}`, { ttl: "match", noCache: true });
            if (m && (m.teamfights != null || m.chat != null)) {
              return { job_id: jobId, status: "completed", parsed: true, note: "Deep data ready — call get_match with include.teamfights." };
            }
          } catch {
            /* match not retrievable yet; keep polling */
          }
        }
      }
      return {
        job_id: jobId,
        status: "unfinished_after_wait",
        note: "Parsing can take minutes. Re-call get_match later (include.teamfights) or poll get_parse_job_status.",
      };
    },
  },
  {
    name: "get_parse_job_status",
    description: "Check the status of a match parse job submitted via request_match_parse.",
    schema: {
      job_id: z.string().describe("Job id returned by request_match_parse."),
    },
    handler: async (args) => {
      let job: unknown;
      try {
        job = await apiGet(`/request/${encodeURIComponent(args.job_id)}`, { ttl: "listing", noCache: true });
      } catch (err) {
        return { status: "error", detail: err instanceof Error ? err.message : String(err) };
      }
      if (job == null || (typeof job === "object" && Object.keys(job as object).length === 0)) {
        return {
          status: "unknown",
          note: "OpenDota returned no job record — finished jobs are often cleaned up. Verify by calling get_match with include.teamfights.",
        };
      }
      return { status: "in_progress", job };
    },
  },
];

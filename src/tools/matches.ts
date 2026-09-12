import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichMatch } from "../enrich.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";
const accountIdOptional = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Optional account id of the holder (default: whoever bought the item).");

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
          breakdown: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Per-player deep breakdown: gold/xp income sources, action types, damage sources by ability, killed/killed_by maps, rune pickups.",
            ),
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
        breakdown: include.breakdown ?? false,
      });
    },
  },
  {
    name: "get_item_impact",
    description:
      "Was buying ITEM X worth it in THIS match? The item-ownership ROI report: when it was bought, the " +
      "approximate hold window (until sold/replaced or game end), and what the holder's team actually achieved " +
      "while holding it — teamfights fought/won, holder's damage output and share, deaths, towers/Roshan taken, " +
      "gold gained. Users ask: '\u7b2c\u4e00\u4ef6\u9ed5\u706d\u56de\u62a5\u7387\u5982\u4f55', 'was buying BKB first worth it?'. " +
      "Honest attribution: items that DEAL damage appear in damage_sources (Battle Fury cleave, Dagon); amplifier " +
      "items (Desolator, Medallion) never show direct damage — their gains live inside the 'attacks' bucket, which " +
      "is exactly why this window analysis exists. Parsed matches only.",
    schema: {
      match_id: z.number().int().positive().describe("Parsed match id."),
      item: z
        .union([z.number().int(), z.string()])
        .describe("Item id, internal name, display name or nickname (\u9ed5\u706d/desolator/bkb...)."),
      account_id: accountIdOptional,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const { resolveItemIdInput } = await import("./scenarios.js");
      const itemId = await resolveItemIdInput(args.item, lang);
      if (itemId == null) {
        return { error: `Unknown item: ${args.item}`, hint: "Resolve with search_dota_entities first." };
      }
      const match = await apiGet<Record<string, any>>(`/matches/${args.match_id}`, { ttl: "match" });
      const rawPlayers = (match?.players ?? []) as Record<string, any>[];
      if (!match?.version) {
        return { error: "Match is not parsed — call request_match_parse first.", hint: "Deep data needs the replay." };
      }
      const { getItemIds } = await import("../constants.js");
      const ids = await getItemIds();
      const internalName = Object.entries(ids).find(([id]) => Number(id) === itemId)?.[1] as string | undefined;
      if (!internalName) return { error: `Item id ${itemId} not in constants.` };

      // Holder: explicit account, else the first player who bought it.
      const holderIdx = rawPlayers.findIndex((p) =>
        args.account_id != null
          ? p.account_id === args.account_id
          : (p.purchase_log ?? []).some((e: Record<string, any>) => e.key === internalName),
      );
      if (holderIdx < 0) {
        return {
          error: `No player in this match bought ${args.item}${args.account_id != null ? ` (account ${args.account_id})` : ""}.`,
          hint: "Check the item name; players' full purchase history is in get_match include.player_logs.",
        };
      }
      const holder = rawPlayers[holderIdx];
      const purchases = (holder.purchase_log ?? []).filter((e: Record<string, any>) => e.key === internalName);
      const boughtAt = purchases[0]?.time as number | undefined;
      if (boughtAt == null) return { error: `Player never bought ${internalName} in this match.` };

      const finalInternalIds = new Set(
        [0, 1, 2, 3, 4, 5].map((sl) => holder[`item_${sl}`]).filter((v: unknown) => v != null && v !== 0).map((v: number) => String(ids[String(v)] ?? "")),
      );
      const kept = finalInternalIds.has(internalName);
      const duration = match.duration as number;
      // Sale time is not recorded upstream; when the item is gone from the final
      // inventory, approximate the hold window with the NEXT notable purchase
      // (>=2000g by cost lookup) — usually the replacement.
      let windowEnd = duration;
      let windowApprox = false;
      if (!kept) {
        const { getItems } = await import("../constants.js");
        const items = await getItems();
        const next = (holder.purchase_log ?? []).find(
          (e: Record<string, any>) => (e.time as number) > boughtAt + 30 && (items[String(e.key)]?.cost ?? 0) >= 2000,
        );
        if (next) {
          windowEnd = next.time as number;
          windowApprox = true;
        }
      }

      // Teamfights overlapping the hold window.
      const side = (p: Record<string, any>) => (((p.player_slot ?? 0) < 128) === ((holder.player_slot ?? 0) < 128));
      const fights = (match.teamfights ?? []) as Record<string, any>[];
      const inWindow = fights.filter((tf) => tf.end >= boughtAt && tf.start <= windowEnd);
      let myDmg = 0;
      let myDeaths = 0;
      let fightsWon = 0;
      let teamDmg = 0;
      for (const tf of inWindow) {
        const tfPlayers = (tf.players ?? []) as Record<string, any>[];
        const teamDelta = tfPlayers
          .map((tp, i) => ({ tp, p: rawPlayers[i] }))
          .filter(({ p }) => p && side(p))
          .reduce((s, { tp }) => s + (tp.gold_delta ?? 0), 0);
        if (teamDelta > 0) fightsWon++;
        teamDmg += tfPlayers
          .map((tp, i) => ({ tp, p: rawPlayers[i] }))
          .filter(({ p }) => p && side(p))
          .reduce((s, { tp }) => s + (tp.damage ?? 0), 0);
        myDmg += tfPlayers[holderIdx]?.damage ?? 0;
        myDeaths += tfPlayers[holderIdx]?.deaths ?? 0;
      }

      // Objectives inside the window (tower/rosh/barracks by holder's team).
      const objectives = (match.objectives ?? []) as Record<string, any>[];
      const objIn = objectives.filter(
        (o) => (o.time as number) >= boughtAt && (o.time as number) <= windowEnd && o.team != null,
      );
      const holderSideIsRadiant = (holder.player_slot ?? 0) < 128;
      const teamScore = (o: Record<string, any>) => ((o.team === 2 || o.team === 0) === holderSideIsRadiant);
      const towers = objIn.filter((o) => o.type === "tower_kill" && teamScore(o)).length;
      const roshans = objIn.filter((o) => o.type === "roshan_kill" && teamScore(o)).length;

      // Gold earned while holding (gold_t deltas).
      const goldT = (holder.gold_t ?? []) as number[];
      const startIdx = Math.max(0, Math.min(goldT.length - 1, Math.floor(boughtAt / 60)));
      const endIdx = Math.max(0, Math.min(goldT.length - 1, Math.floor(windowEnd / 60)));
      const goldGained = goldT.length > 1 ? goldT[endIdx] - goldT[startIdx] : undefined;

      const { abilityRef, itemRef } = await import("../mapping.js");
      const ref = await itemRef(itemId, lang);

      const dmgSources = await Promise.all(
        Object.entries(holder.damage_inflictor ?? {})
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .slice(0, 6)
          .map(async ([k, v]) => {
            if (k == null || k === "null") return { source: lang === "schinese" || lang === "tchinese" ? "普攻" : "attacks", damage: v };
            const { getAbilityIds } = await import("../constants.js");
            const abId = Number(Object.entries(await getAbilityIds()).find(([, n]) => n === k)?.[0]);
            const ab = Number.isFinite(abId) && abId > 0 ? await abilityRef(abId, lang) : undefined;
            const item = ab ? undefined : await (async () => {
              const { itemInternalRef } = await import("../enrich.js");
              return itemInternalRef(k, lang);
            })();
            return { source: ab?.name ?? item?.name ?? k, damage: v, kind: ab ? "ability" : item ? "item" : "other" };
          }),
      );

      return {
        match_id: args.match_id,
        player: { account_id: holder.account_id, personaname: holder.personaname, hero: undefined },
        hero: undefined,
        item: ref?.name ?? internalName,
        bought_at: Math.floor(boughtAt / 60) + ":" + String(Math.floor(boughtAt % 60)).padStart(2, "0"),
        hold_window: {
          until: Math.floor(windowEnd / 60) + ":" + String(Math.floor(windowEnd % 60)).padStart(2, "0"),
          minutes: Math.round((windowEnd - boughtAt) / 60),
          fate: kept ? "kept until the end" : "sold/replaced (sale time not recorded — window approximated to the next big purchase)",
          approximated: windowApprox,
        },
        while_holding: {
          teamfights: inWindow.length,
          teamfights_won: fightsWon,
          holder_damage: myDmg,
          holder_share_pct: teamDmg > 0 ? Math.round((myDmg / teamDmg) * 1000) / 10 : undefined,
          holder_deaths: myDeaths,
          towers_taken: towers,
          roshans_taken: roshans,
          holder_gold_gained: goldGained,
        },
        damage_sources_context: dmgSources,
        note:
          "Amplifier items (armor reduction, Medallion) and stat items NEVER appear in damage_sources — their gains " +
          "hide inside the 'attacks' bucket; this window analysis is how their ROI is measured. Items that proc " +
          "damage (Battle Fury, Dagon, Radiance) DO appear in damage_sources with exact attribution.",
        source: "opendota parsed replay",
      };
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

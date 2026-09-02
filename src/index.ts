#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_LANGUAGE, shouldSeedBundle } from "./config.js";
import { normalizeLanguage } from "./locales.js";
import { matchTools } from "./tools/matches.js";
import { playerTools } from "./tools/players.js";
import { heroTools } from "./tools/heroes.js";
import { proTools } from "./tools/pro.js";
import type { ToolContext, ToolDef } from "./tools/registry.js";
import { referenceTools } from "./tools/reference.js";
import { scenarioTools } from "./tools/scenarios.js";
import { systemTools } from "./tools/system.js";
import { teamTools } from "./tools/teams.js";
import {
  getAbilities,
  getAbilityIds,
  getChatWheel,
  getCountries,
  getGameModes,
  getHeroAbilities,
  getHeroes,
  getItemIds,
  getItems,
  getLobbyTypes,
  getOrderTypes,
  getPermanentBuffs,
  getPatches,
  getRegions,
} from "./constants.js";
import { apiGet, readBundleManifest, seedConstantsFromBundle, updateBundleManifest } from "./client.js";
import { LOG_TARGET, logBoot, logToolCall, newTraceId, traceStorage } from "./telemetry.js";
import { registerPrompts } from "./prompts.js";
import { STRATZ_ENABLED } from "./stratz.js";
import { stratzTools } from "./tools/stratz.js";

const PACKAGE_VERSION = "0.10.1";

const allTools: ToolDef[] = [
  ...systemTools,
  ...matchTools,
  ...playerTools,
  ...heroTools,
  ...teamTools,
  ...proTools,
  ...referenceTools,
  ...scenarioTools,
  ...(STRATZ_ENABLED ? stratzTools : []),
];

const ctx: ToolContext = {
  defaultLanguage: normalizeLanguage(DEFAULT_LANGUAGE),
};

const server = new McpServer(
  { name: "opendota-mcp", version: PACKAGE_VERSION },
  {
    instructions:
      "Dota 2 data via the OpenDota API. HOW TO USE: " +
      "(1) Resolve any player/hero/item name first — search_players for accounts, search_dota_entities for " +
      "game entities (accepts any language, e.g. 敌法师). (2) Never guess account ids or describe " +
      "abilities/items from memory — use get_hero_kit / get_item_details for authoritative current-patch data. " +
      "(3) For match analysis prefer the registered prompts (match-analysis, player-review, hero-guide, " +
      "meta-report) which encode the full playbook. (4) Unparsed matches return a note — call " +
      "request_match_parse to unlock deep data. (5) Position fields carry position_basis; treat " +
      "farm_order_only as a low-confidence guess. " +
      (STRATZ_ENABLED
        ? "(6) Rank-bracket/position-split aggregates (get_matchups_by_rank, get_item_builds_by_rank, " +
          "get_talent_stats, get_lane_matchups, get_draft_advice, get_hero_trend) come from STRATZ with much " +
          "larger samples than the OpenDota scenario tools — prefer them for counter/item/talent/lane/draft " +
          "questions, and quote win rates with their ci95_pp. "
        : "") +
      `Names are localized (default ${ctx.defaultLanguage}; per-call language param or OPENDOTA_LANGUAGE env). ` +
      "Free tier ~60 requests/min; set OPENDOTA_API_KEY for more.",
  },
);

registerPrompts(server);

for (const tool of allTools) {
  server.tool(tool.name, tool.description, tool.schema, async (args) => {
    const traceId = newTraceId();
    const startedAt = Date.now();
    try {
      const data = await traceStorage.run({ trace_id: traceId, tool: tool.name }, () =>
        tool.handler(args as Record<string, unknown>, ctx),
      );
      logToolCall({
        trace_id: traceId,
        tool: tool.name,
        duration_ms: Date.now() - startedAt,
        ok: true,
        result_bytes: JSON.stringify(data).length,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logToolCall({
        trace_id: traceId,
        tool: tool.name,
        duration_ms: Date.now() - startedAt,
        ok: false,
        error: message.slice(0, 300),
      });
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });
}

async function main(): Promise<void> {
  // Boot sequence: one small patch probe (noCache) is the only network cost of
  // a cold start. Compare it to the shipped bundle manifest, then seed the
  // constants cache from the bundle. If the API knows a newer patch (new
  // heroes/items ship with patches), refresh every constants resource in the
  // background so they appear within seconds. SWR keeps the seeded entries
  // fresh hourly after that. A failed probe (offline/degraded API) just runs
  // on the bundle; custom OPENDOTA_BASE_URL instances skip seeding entirely.
  const manifest = readBundleManifest();
  if (shouldSeedBundle()) {
    const PROBE_INTERVAL_MS = 60 * 60 * 1000;
    const probedRecently =
      manifest?.last_probe_at != null &&
      Date.now() - Date.parse(manifest.last_probe_at) < PROBE_INTERVAL_MS;
    if (probedRecently) {
      // Hosts that restart the MCP per conversation turn (common for chat agents)
      // would otherwise re-probe on every boot; within an hour the previous
      // probe result is still authoritative, so boot costs zero requests.
      const seeded = seedConstantsFromBundle();
      logBoot({ version: PACKAGE_VERSION, seeded_resources: seeded.length, probe: "skipped_recent" });
      console.error(`boot: seeded ${seeded.length} constants, probe skipped (ran ${manifest?.last_probe_at})`);
    } else {
      let apiMaxPatch: number | undefined;
      try {
        const patches = await apiGet<{ id?: number }[]>("/constants/patch", {
          ttl: "constants",
          noCache: true,
        });
        apiMaxPatch = patches.reduce((max, p) => Math.max(max, p.id ?? 0), 0);
        updateBundleManifest({ last_probe_at: new Date().toISOString(), last_probe_max_patch: apiMaxPatch });
      } catch {
        /* offline or degraded — seed and continue */
      }
      const seeded = seedConstantsFromBundle();
      const stale =
        apiMaxPatch != null && manifest?.max_patch_id != null && apiMaxPatch > manifest.max_patch_id;
      logBoot({
        version: PACKAGE_VERSION,
        seeded_resources: seeded.length,
        api_max_patch: apiMaxPatch ?? null,
        bundled_max_patch: manifest?.max_patch_id ?? null,
        stale_detected: stale,
        log_target: LOG_TARGET,
      });
      console.error(
        `boot: seeded ${seeded.length} constants from bundle` +
          (apiMaxPatch != null ? `, api patch ${apiMaxPatch} vs bundled ${manifest?.max_patch_id}` : ", probe failed") +
          (stale ? " — newer patch detected, refreshing constants" : ""),
      );
      if (stale) {
        for (const resource of manifest?.resources ?? []) {
          apiGet(`/constants/${resource}`, { ttl: "constants", forceRefresh: true }).catch(() => {});
        }
      }
    }
  }
  // Pre-warm whatever the bundle did not cover so the first enriched response
  // never blocks on a serial constants fetch. All parallel; with a seeded
  // bundle these are cache hits and cost zero requests.
  for (const load of [
    getHeroes,
    getItems,
    getItemIds,
    getAbilities,
    getAbilityIds,
    getGameModes,
    getLobbyTypes,
    getRegions,
    getPatches,
    getHeroAbilities,
    getPermanentBuffs,
    getChatWheel,
    getOrderTypes,
    getCountries,
  ]) {
    load().catch(() => {});
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only; stdout is reserved for the MCP protocol.
  console.error(`opendota-mcp v${PACKAGE_VERSION} ready: ${allTools.length} tools, language=${ctx.defaultLanguage}`);
}

main().catch((err) => {
  console.error("Fatal error starting opendota-mcp:", err);
  process.exit(1);
});

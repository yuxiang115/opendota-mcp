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

const PACKAGE_VERSION = "0.8.0";

const allTools: ToolDef[] = [
  ...systemTools,
  ...matchTools,
  ...playerTools,
  ...heroTools,
  ...teamTools,
  ...proTools,
  ...referenceTools,
];

const ctx: ToolContext = {
  defaultLanguage: normalizeLanguage(DEFAULT_LANGUAGE),
};

const server = new McpServer(
  { name: "opendota-mcp", version: PACKAGE_VERSION },
  {
    instructions:
      "Dota 2 data via the OpenDota API. All hero/item/ability ids are resolved to names, and " +
      `names are localized (default language: ${ctx.defaultLanguage}; change per-call with the language ` +
      "parameter, or globally with the OPENDOTA_LANGUAGE env var). Resolve player/hero names first with " +
      "search_players / search_dota_entities. Free tier allows ~60 requests/minute; set OPENDOTA_API_KEY " +
      "for higher limits.",
  },
);

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

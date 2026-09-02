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
import { apiGet, readBundleManifest, seedConstantsFromBundle } from "./client.js";

const PACKAGE_VERSION = "0.6.1";

const allTools: ToolDef[] = [
  ...systemTools,
  ...matchTools,
  ...playerTools,
  ...heroTools,
  ...teamTools,
  ...proTools,
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
    try {
      const data = await tool.handler(args as Record<string, unknown>, ctx);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
    let apiMaxPatch: number | undefined;
    try {
      const patches = await apiGet<{ id?: number }[]>("/constants/patch", {
        ttl: "constants",
        noCache: true,
      });
      apiMaxPatch = patches.reduce((max, p) => Math.max(max, p.id ?? 0), 0);
    } catch {
      /* offline or degraded — seed and continue */
    }
    const seeded = seedConstantsFromBundle();
    const stale =
      apiMaxPatch != null && manifest?.max_patch_id != null && apiMaxPatch > manifest.max_patch_id;
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

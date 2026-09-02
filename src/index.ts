#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_LANGUAGE } from "./config.js";
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
  getGameModes,
  getHeroes,
  getItemIds,
  getItems,
  getLobbyTypes,
  getPatches,
  getRegions,
} from "./constants.js";

const PACKAGE_VERSION = "0.2.0";

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
  // Pre-warm the constants cache in the background so the first enriched
  // response (match rows resolve heroes/modes per player) is fast.
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

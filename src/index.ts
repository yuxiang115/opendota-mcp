#!/usr/bin/env node
// `opendota-mcp install-skill [claude-code|zcode|openclaw|all] [--force]` copies the
// shipped Agent Skill into host skill directories, then exits. Everything else starts the MCP server.
if (process.argv[2] === "install-skill") {
  const { installSkill } = await import("./install-skill.js");
  installSkill(process.argv.slice(3));
  process.exit(0);
}
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
import { stratzAvailable } from "./stratz.js";
import { sessionCreds, type SessionCreds } from "./session.js";
import { createRequire } from "node:module";

// Single source of truth: the package.json sitting next to dist/. Reading it at
// runtime (instead of a hardcoded literal) keeps the reported version honest in
// every install shape (repo, npx cache, container deploy).
const PACKAGE_VERSION: string = createRequire(import.meta.url)("../package.json").version;

function toolsFor(includeStratz: boolean): ToolDef[] {
  return [
    ...systemTools,
    ...matchTools,
    ...playerTools,
    ...heroTools,
    ...teamTools,
    ...proTools,
    ...referenceTools,
    ...scenarioTools,
    ...(includeStratz ? stratzTools : []),
  ];
}

const ctx: ToolContext = {
  defaultLanguage: normalizeLanguage(DEFAULT_LANGUAGE),
};

/**
 * Fresh McpServer with every tool + prompt registered. stdio mode uses one
 * instance for the process; HTTP mode creates one per session (SDK requirement
 * for stateful streamable-HTTP sessions).
 */
function buildServer(opts: { includeStratz?: boolean } = {}): McpServer {
  const includeStratz = opts.includeStratz ?? STRATZ_ENABLED;
  const allTools = toolsFor(includeStratz);
  const server = new McpServer(
    { name: "opendota-mcp", version: PACKAGE_VERSION },
    {
      instructions:
        "Dota 2 data via the OpenDota API. HOW TO USE: " +
        "(1) Resolve any player/hero/item name first — search_players for accounts, search_dota_entities for " +
        "game entities (accepts any language, e.g. 敌法师, AND community nicknames like 火猫/大骨灰/BKB/PA; " +
        "ambiguous nicknames like 猴子/ES return candidate heroes — ask the user which they mean, never guess). For any 'how is this player' question call get_player_overview FIRST (one-call dashboard). (2) Never guess account ids or describe " +
        "abilities/items from memory — use get_hero_kit / get_item_details for authoritative current-patch data. " +
        "(3) For match analysis prefer the registered prompts (match-analysis, player-review, hero-guide, " +
        "meta-report) which encode the full playbook. (4) Unparsed matches return a note — call " +
        "request_match_parse to unlock deep data. (5) Position fields carry position_basis; treat " +
        "farm_order_only as a low-confidence guess. " +
        "(6) DATA FRESHNESS: OpenDota's index lags — sometimes by hours, occasionally days for unranked " +
        "modes like Turbo. If the user mentions games that are missing from their recent list, call " +
        "refresh_player(account_id) once, wait a few seconds, then re-query. ALL timestamps in responses are " +
        "UTC — ALWAYS convert to the user's local timezone (you usually know it from the user's profile) " +
        "before quoting dates/times, and label the timezone. " +
        "(7) ALWAYS use these tools for Dota data — never fetch api.opendota.com yourself (via exec/curl/" +
        "web tools): raw responses contain untranslated numeric ids, no caching, and burn the user's rate " +
        "limit. Everything the API offers is exposed here, already enriched and cached. " +
        (includeStratz
          ? "(8) Rank-bracket/position-split aggregates (get_matchups_by_rank, get_item_builds_by_rank, " +
            "get_talent_stats, get_skill_builds_by_rank, get_lane_matchups, get_draft_advice, get_hero_trend) come " +
            "from STRATZ with much larger samples than the OpenDota scenario tools — prefer them for " +
            "counter/item/talent/lane/draft questions, and quote win rates with their ci95_pp. "
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
  return server;
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
  const transportMode =
    process.env.OPENDOTA_TRANSPORT?.toLowerCase() === "http" || process.env.PORT ? "http" : "stdio";
  if (transportMode === "http") {
    await startHttpServer();
  } else {
    const transport = new StdioServerTransport();
    await buildServer().connect(transport);
    // Log to stderr only; stdout is reserved for the MCP protocol.
    console.error(`opendota-mcp v${PACKAGE_VERSION} ready: ${toolsFor(STRATZ_ENABLED).length} tools, language=${ctx.defaultLanguage}`);
  }
}

/**
 * Streamable HTTP transport (MCP spec 2025-03-26) for remote/docker deployments:
 *   POST   /mcp   client→server messages (initialize, tool calls, ...)
 *   GET    /mcp   server→client SSE stream (optional, per session)
 *   DELETE /mcp   terminate a session
 *   GET    /healthz  unauthenticated liveness probe
 * Sessions are stateful: one McpServer instance per mcp-session-id. Set
 * OPENDOTA_HTTP_TOKEN to require `Authorization: Bearer <token>` on /mcp.
 */
async function startHttpServer(): Promise<void> {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { createServer } = await import("node:http");
  const { randomUUID } = await import("node:crypto");

  const port = Number(process.env.PORT ?? 8787);
  const authToken = process.env.OPENDOTA_HTTP_TOKEN?.trim();
  const sessions = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  const header = (req: import("node:http").IncomingMessage, name: string): string | undefined => {
    const v = req.headers[name];
    const t = Array.isArray(v) ? v[0] : v;
    return t && t.trim() ? t.trim() : undefined;
  };

  const readBody = (req: import("node:http").IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found — the MCP endpoint is POST /mcp" }));
      return;
    }
    // Per-caller upstream credentials: bring-your-own-key so the caller's
    // traffic bills to their OpenDota/STRATZ quota, not the operator's.
    // Headers are the preferred vehicle; URL query params are the fallback for
    // clients whose config UI cannot set custom headers (ChatGPT connectors):
    //   https://host/mcp?stratz_token=...&opendota_key=...
    // Caveat: proxies log query strings, so the token lands in their access logs.
    const creds: SessionCreds = {
      openDotaKey: header(req, "x-opendota-key") ?? (url.searchParams.get("opendota_key") ?? undefined),
      stratzToken: header(req, "x-stratz-token") ?? (url.searchParams.get("stratz_token") ?? undefined),
    };
    if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="opendota-mcp"' });
      res.end(JSON.stringify({ error: "unauthorized — set Authorization: Bearer <OPENDOTA_HTTP_TOKEN>" }));
      return;
    }
    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "session not found (expired or restarted)" }));
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          transport.onclose = () => {
            if (transport!.sessionId) sessions.delete(transport!.sessionId);
          };
          // STRATZ tools light up for this session when the caller brought
          // their own token even if the server has none configured.
          await buildServer({ includeStratz: stratzAvailable() || !!creds.stratzToken }).connect(transport);
          await sessionCreds.run(creds, () => transport!.handleRequest(req, res, body));
          // The session id is only generated while handling the initialize
          // request, so the map entry has to be written afterwards.
          if (transport.sessionId && !sessions.has(transport.sessionId)) {
            sessions.set(transport.sessionId, transport);
          }
          return;
        }
        await sessionCreds.run(creds, () => transport.handleRequest(req, res, body));
      } else if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `${req.method} requires a valid mcp-session-id header` }));
          return;
        }
        await sessionCreds.run(creds, () => transport.handleRequest(req, res));
      } else {
        res.writeHead(405, { allow: "GET, POST, DELETE" });
        res.end();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`http transport error (${req.method} ${pathname}):`, message);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  console.error(
    `opendota-mcp v${PACKAGE_VERSION} ready (http): ${toolsFor(STRATZ_ENABLED).length} tools base (STRATZ tools light up per session), listening on :${port}/mcp` +
      `${authToken ? " (bearer auth on)" : " (NO auth token set — anyone reachable can use it)"}, language=${ctx.defaultLanguage}`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting opendota-mcp:", err);
  process.exit(1);
});

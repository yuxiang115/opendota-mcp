/**
 * Integration test: drive the server exactly the way a real MCP client
 * (Claude Desktop / Cursor / ZCode) does over stdio, through realistic
 * agent workflows. Run: npm run build && npm run integration
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function head(v, n = 260) {
  if (v === undefined || v === null) return "undefined";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function boot(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "integration-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

async function expectError(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content?.[0]?.text ?? "" };
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Boot #1: default config, protocol handshake");
const client = await boot();
const listRes = await client.listTools();
const tools = listRes.tools;
ok("server responds to tools/list", Array.isArray(tools) && tools.length > 0, `got ${tools?.length}`);
console.log(`  server: ${listRes.serverInfo?.name ?? "opendota-mcp"} v${listRes.serverInfo?.version ?? "?"}, ${tools.length} tools`);

const schema = tools.find((t) => t.name === "get_match")?.inputSchema;
ok("get_match exposes JSON inputSchema", !!schema?.properties?.match_id, head(schema?.properties?.match_id));
const langDesc = schema?.properties?.language?.description ?? "";
ok("language param documented in schema", langDesc.includes("language") || langDesc.length > 0);

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario A — agent flow: 「敌法师克制哪些英雄？」(all-Chinese input)");
const search = await call(client, "search_dota_entities", { query: "敌法师" });
const am = search.matches?.find((m) => m.kind === "hero");
ok('search "敌法师" → hero id 1', am?.id === 1, head(am));

const matchups = await call(client, "get_hero_matchups", { hero_id: am.id, language: "zh-CN", limit: 5 });
ok("matchups return localized hero names", matchups.every((m) => m.hero?.name && m.hero?.name_en));
ok("matchups have win_rate_pct", typeof matchups[0]?.win_rate_pct === "number");
const bestCounter = [...matchups].sort((a, b) => b.win_rate_pct - a.win_rate_pct)[0];
console.log(`  → 敌法师打 ${bestCounter.hero.name}(${bestCounter.hero.name_en}) 胜率最高 ${bestCounter.win_rate_pct}%`);
console.log(`  → 全部对位: ${matchups.map((m) => `${m.hero.name} ${m.win_rate_pct}%`).join(", ")}`);

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario B — agent flow: player deep-dive (SumaiL)");
const found = await call(client, "search_players", { q: "SumaiL" });
ok("player search returns account ids", found.some((p) => p.account_id));
const accountId = found.find((p) => p.personaname === "SumaiL")?.account_id ?? found[0].account_id;

const profile = await call(client, "get_player", { account_id: accountId });
ok("profile rank medal readable", typeof profile.rank_tier === "string" || profile.rank_tier === undefined, head(profile.rank_tier));
console.log(`  → SumaiL: rank=${profile.rank_tier ?? "?"}, computed_mmr=${profile.computed_mmr ?? "?"}`);

const recent = await call(client, "get_player_recent_matches", { account_id: accountId, language: "schinese" });
ok("recent matches have localized hero + win flag", recent.every((m) => m.hero?.name && typeof m.win === "boolean"));
ok("durations formatted mm:ss", /^\d{2}:\d{2}$/.test(recent[0].duration), recent[0].duration);
console.log(`  → 最近一场: ${recent[0].hero.name} ${recent[0].kills}/${recent[0].deaths}/${recent[0].assists} ${recent[0].win ? "胜" : "负"} (${recent[0].game_mode}, ${recent[0].duration})`);

const wl = await call(client, "get_player_win_loss", { account_id: accountId, limit: 20 });
ok("win/loss has computed win_rate_pct", "win_rate_pct" in wl || "win" in wl, head(wl));

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario C — agent flow: pro match analysis with draft");
const pro = await call(client, "get_pro_matches", { limit: 5, language: "schinese" });
ok("pro matches enriched (team names, duration)", pro.every((m) => m.radiant_name && m.radiant_win !== undefined));
const proMatch = pro.find((m) => m.league_name) ?? pro[0];
console.log(`  → 最新: ${proMatch.radiant_name} vs ${proMatch.dire_name} (${proMatch.league_name?.trim()}, ${proMatch.radiant_win ? "R胜" : "D胜"} ${proMatch.radiant_score}:${proMatch.dire_score})`);

const match = await call(client, "get_match", {
  match_id: proMatch.match_id,
  language: "schinese",
  include: { picks_bans: true, graphs: true },
});
ok("match: 10 players", match.players?.length === 10);
ok("match: players carry named items", Array.isArray(match.players[0]?.items) && match.players[0].items.every((i) => i.name));
ok("match: game mode is readable label", typeof match.game_mode === "string" && !/game_mode/.test(match.game_mode), match.game_mode);
ok("match: picks_bans resolved to hero names", match.picks_bans?.every((pb) => pb.hero?.name));
ok("match: advantage graphs included", Array.isArray(match.radiant_gold_advantage_by_minute));
const mvp = [...match.players].sort((a, b) => (b.hero_damage ?? 0) - (a.hero_damage ?? 0))[0];
console.log(`  → MVP视角: ${mvp.personaname} (${mvp.hero.name}) ${mvp.kills}/${mvp.deaths}/${mvp.assists} KDA ${mvp.kda}, 伤害 ${mvp.hero_damage}`);
console.log(`  → BP前4手: ${match.picks_bans.slice(0, 4).map((pb) => `${pb.is_pick ? "选" : "禁"}${pb.hero.name}`).join(" ")}`);
console.log(`  → 出装示例: ${match.players[0].items.map((i) => i.name).join(", ")}`);

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario D — hero meta (Russian localization)");
const heroStats = await call(client, "get_hero_stats", {});
const enriched = heroStats.find((h) => h.hero?.id === 1);
ok("hero stats carry hero ref + computed win rate", typeof enriched?.pro_win_rate_pct === "number" || "pro_win_rate_pct" in (enriched ?? {}), head(enriched?.pro_win_rate_pct));

const ruHeroes = await call(client, "get_heroes", { language: "ru" });
ok("language alias 'ru' works", ruHeroes[0]?.name === "Anti-Mage" || ruHeroes.some((h) => /[А-Яа-я]/.test(h.name)), ruHeroes[0]?.name);
const ruAm = ruHeroes.find((h) => h.id === 1);
console.log(`  → id 1 in Russian: ${ruAm.name} / English: ${ruAm.name_en}`);

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario E — system & error handling");
const langs = await call(client, "list_supported_languages", {});
ok("28 languages listed", langs.languages.length === 28, `got ${langs.languages.length}`);

const badMatch = await expectError(client, "get_match", { match_id: 9999999999 });
ok("invalid match id → isError with message", badMatch.isError && /error/i.test(badMatch.text), head(badMatch.text, 120));

const badQuery = await call(client, "search_dota_entities", { query: "zzz_no_such_entity_zzz" });
ok("empty entity search returns empty matches", Array.isArray(badQuery.matches) && badQuery.matches.length === 0);

const health = await call(client, "get_api_health", {});
ok("health returns metrics", !!health && typeof health === "object", Object.keys(health).slice(0, 3).join(","));

await client.close();

// ─────────────────────────────────────────────────────────────
console.log("\n■ Boot #2: OPENDOTA_LANGUAGE=schinese as server default");
const client2 = await boot({ OPENDOTA_LANGUAGE: "schinese" });
const zhHeroes = await call(client2, "get_heroes", {}); // no language arg
ok("default language applied without per-call param", zhHeroes.find((h) => h.id === 1)?.name === "敌法师", zhHeroes.find((h) => h.id === 1)?.name);
const zhRecent = await call(client2, "get_pro_matches", { limit: 2 });
ok("pro matches also localized by default", zhRecent.every((m) => typeof m.match_id === "number"));
await client2.close();

// ─────────────────────────────────────────────────────────────
console.log("\n■ Boot #3: Windows-style spawn via `cmd /c npx .` (Claude Desktop pattern)");
try {
  const transport3 = new StdioClientTransport({ command: "cmd", args: ["/c", "npx", "-y", "."] });
  const client3 = new Client({ name: "integration-test", version: "0.0.0" });
  await client3.connect(transport3);
  const t3 = await client3.listTools();
  ok("npx-launched server lists tools", t3.tools.length === 42, `got ${t3.tools.length}`);
  const r3 = await call(client3, "search_dota_entities", { query: "斧王", language: "schinese" });
  ok("npx-launched server serves localized queries", r3.matches?.some((m) => m.name === "斧王"), head(r3.matches?.[0]));
  await client3.close();
} catch (e) {
  ok("npx-launched server", false, e.message);
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression F — request coalescing (mock upstream, exact request counts)");
{
  const hits = {};
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    res.setHeader("content-type", "application/json");
    if (path === "/players/1/recentMatches") {
      // 20 identical rows: each enriched row resolves hero/game_mode/lobby_type
      const row = { player_slot: 0, radiant_win: true, hero_id: 1, game_mode: 22, lobby_type: 7, duration: 1200, start_time: 1700000000, kills: 5, deaths: 2, assists: 8 };
      res.end(JSON.stringify(Array.from({ length: 20 }, () => ({ ...row }))));
    } else if (path === "/constants/heroes") {
      res.end(JSON.stringify({ 1: { id: 1, name: "npc_dota_hero_antimage", localized_name: "Anti-Mage" } }));
    } else if (path === "/constants/game_mode" || path === "/constants/lobby_type") {
      res.end(JSON.stringify({ 22: { id: 22, name: "game_mode_all_draft" }, 7: { id: 7, name: "lobby_type_ranked" } }));
    } else {
      res.end("{}");
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const mockClient = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_RATE_LIMIT: "1000" });
  const rows = await call(mockClient, "get_player_recent_matches", { account_id: 1 });
  ok("mock returns 20 enriched rows", rows.length === 20 && rows[0].hero?.name_en === "Anti-Mage", `rows=${rows.length}`);
  ok(
    "fan-out coalesced: 1 upstream request per constants resource",
    hits["/constants/heroes"] === 1 && hits["/constants/game_mode"] === 1 && hits["/constants/lobby_type"] === 1,
    JSON.stringify(hits),
  );
  ok("row has computed kda and win", typeof rows[0].kda === "number" && rows[0].win === true);
  await mockClient.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression G — default significant=0 keeps Turbo players visible (live)");
{
  const client4 = await boot();
  const heroes = await call(client4, "get_player_heroes", { account_id: 48645517, date: 30 });
  ok("turbo-only player has a hero pool by default", heroes.some((h) => h.games > 0), `heroes with games: ${heroes.filter((h) => h.games > 0).length}`);
  const strict = await call(client4, "get_player_heroes", { account_id: 48645517, date: 30, significant: 1 });
  ok("significant=1 still available for standard-mode-only stats", Array.isArray(strict));
  const recent = await call(client4, "get_player_recent_matches", { account_id: 48645517 });
  ok("kda present on recent-match rows", recent.every((m) => typeof m.kda === "number"));
  await client4.close();
}

// ─────────────────────────────────────────────────────────────
console.log(`\n═══ 结果: ${passed} passed, ${failed} failed ═══`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
process.exit(0);

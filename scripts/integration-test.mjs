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

/** SKIP_LIVE=1 runs only the offline mock regressions (F-K) — useful when OpenDota is down or in CI. */
const LIVE = !process.env.SKIP_LIVE;
if (!LIVE) console.log("(SKIP_LIVE=1: online scenarios disabled, mock regressions only)");

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
// The server reads its version from package.json at runtime — drift here means
// a deploy is lying about what code it runs.
const { readFileSync: readPkg } = await import("node:fs");
const pkgVersion = JSON.parse(readPkg(new URL("../package.json", import.meta.url), "utf8")).version;
const serverVersion = client.getServerVersion()?.version;
ok(
  `server version matches package.json (${pkgVersion})`,
  serverVersion === pkgVersion,
  `server says ${serverVersion}`,
);

const schema = tools.find((t) => t.name === "get_match")?.inputSchema;
ok("get_match exposes JSON inputSchema", !!schema?.properties?.match_id, head(schema?.properties?.match_id));
const langDesc = schema?.properties?.language?.description ?? "";
ok("language param documented in schema", langDesc.includes("language") || langDesc.length > 0);

// ─────────────────────────────────────────────────────────────
if (LIVE) {
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
// /search is a flaky OpenDota endpoint; the tool returns {error, hint} when it fails.
if (Array.isArray(found)) {
  ok("player search returns account ids", found.some((p) => p.account_id));
} else {
  ok("search failure returns a structured hint", typeof found.hint === "string" && /guess/i.test(found.hint), head(found));
}
const accountId = Array.isArray(found)
  ? (found.find((p) => p.personaname === "SumaiL")?.account_id ?? found[0].account_id)
  : 228003373; // known SumaiL account (SUMAyLLL) — keeps the deep-dive assertions meaningful

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
ok(
  "match: advantage graphs included (or flagged unparsed)",
  Array.isArray(match.radiant_gold_advantage_by_minute) || /Unparsed/.test(match.note ?? ""),
  (match.note ?? "").slice(0, 60),
);
const mvp = [...match.players].sort((a, b) => (b.hero_damage ?? 0) - (a.hero_damage ?? 0))[0];
console.log(`  → MVP视角: ${mvp.personaname} (${mvp.hero.name}) ${mvp.kills}/${mvp.deaths}/${mvp.assists} KDA ${mvp.kda}, 伤害 ${mvp.hero_damage}`);
console.log(`  → BP前4手: ${match.picks_bans.slice(0, 4).map((pb) => `${pb.is_pick ? "选" : "禁"}${pb.hero.name}`).join(" ")}`);
console.log(`  → 出装示例: ${match.players[0].items.map((i) => i.name).join(", ")}`);

// ─────────────────────────────────────────────────────────────
console.log("\n■ Scenario D — hero meta (Russian localization)");
const heroStats = await call(client, "get_hero_stats", {});
const heroList = Array.isArray(heroStats) ? heroStats : heroStats.heroes;
  const enriched = heroList.find((h) => h.hero?.id === 1);
  ok("hero_stats wrapper carries bracket-order note", !Array.isArray(heroStats) && typeof heroStats.note === "string" && heroStats.note.includes("LOW skill to HIGH"));
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
} // LIVE

// ─────────────────────────────────────────────────────────────
console.log("\n■ Boot #3: Windows-style spawn via `cmd /c npx .` (Claude Desktop pattern)");
try {
  const transport3 = new StdioClientTransport({ command: "cmd", args: ["/c", "npx", "-y", "."] });
  const client3 = new Client({ name: "integration-test", version: "0.0.0" });
  await client3.connect(transport3);
  const t3 = await client3.listTools();
  ok("npx-launched server lists tools", t3.tools.length === 56, `got ${t3.tools.length}`);
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
if (LIVE) {
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
console.log("\n■ Regression H — constants stale-while-revalidate (1h TTL by default, tiny here)");
{
  const hits = {};
  let heroPayloadVersion = 1;
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    res.setHeader("content-type", "application/json");
    if (path === "/constants/cluster") {
      res.end(JSON.stringify({ 1: `Anti-Mage v${heroPayloadVersion}` }));
    } else {
      res.end("{}");
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  // TTL 0.02 min = 1.2s so expiry happens within the test
  const swr = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_CONSTANTS_TTL_MINUTES: "0.02", OPENDOTA_RATE_LIMIT: "1000" });
  const first = await call(swr, "get_constants", { resource: "cluster" });
  ok("first fetch returns v1", first?.["1"] === "Anti-Mage v1", JSON.stringify(first?.["1"]));
  const afterFirst = hits["/constants/cluster"];
  await new Promise((r) => setTimeout(r, 1500)); // let the cache expire
  heroPayloadVersion = 2;
  const t0 = Date.now();
  const stale = await call(swr, "get_constants", { resource: "cluster" });
  const ms = Date.now() - t0;
  ok("expired entry served instantly (stale-while-revalidate)", ms < 250, `${ms}ms`);
  ok("stale response is still coherent data", stale?.["1"] === "Anti-Mage v1", JSON.stringify(stale?.["1"]));
  await new Promise((r) => setTimeout(r, 1500)); // background refresh completes
  ok("background refresh hit upstream exactly once more", hits["/constants/cluster"] === afterFirst + 1, `${hits["/constants/cluster"]} vs ${afterFirst}+1`);
  const fresh = await call(swr, "get_constants", { resource: "cluster" });
  ok("next call sees refreshed data", fresh?.["1"] === "Anti-Mage v2", JSON.stringify(fresh?.["1"]));
  await swr.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression I — position 1-5 estimation and log enrichment (mock match)");
{
  const mk = (slot, heroId, lane, lane_role, gpm, extra = {}) => ({
    player_slot: slot, account_id: 1000 + slot, personaname: `p${slot}`, hero_id: heroId,
    lane, lane_role, gold_per_min: gpm, kills: 1, deaths: 1, assists: 1, level: 20,
    radiant_win: true, duration: 1500, start_time: 1700000000, game_mode: 22, lobby_type: 7,
    item_0: 1, kills_log: [{ time: 300, key: "npc_dota_hero_medusa" }], purchase_log: [{ time: 240, key: "bfury" }],
    stuns: 2.5, teamfight_participation: 0.6, buyback_count: 1, towers_killed: 2,
    ...extra,
  });
  const match = {
    match_id: 424242, radiant_win: true, radiant_score: 30, dire_score: 25, duration: 1500,
    start_time: 1700000000, game_mode: 22, lobby_type: 7, players: [
      // Radiant: dual safe, mid, dual off — mirrors real 2-1-2 turbo lanes
      mk(0, 1, 1, 1, 1533),   // safe primary → pos1
      mk(1, 2, 2, 2, 1428),   // mid → pos2
      mk(2, 3, 3, 3, 930),    // off primary → pos3
      mk(3, 4, 1, 1, 923),    // safe secondary → pos4/5 by farm
      mk(4, 5, 3, 3, 868),    // off secondary → pos5
      // Dire (128/130 carry native position_est, proving native beats the farm heuristic)
      mk(128, 6, 1, 3, 1054, { position_est: 4 }),
      mk(129, 7, 2, 2, 1079), // mid → pos2
      mk(130, 8, 1, 3, 879, { position_est: 3 }),
      mk(131, 9, 3, 1, 1080), // dire safe primary → pos1
      mk(132, 10, 3, 1, 523), // dire safe secondary → pos5
    ],
  };
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/matches/424242") res.end(JSON.stringify(match));
    else if (path === "/constants/items") res.end(JSON.stringify({ bfury: { cost: 4100, dname: "Battle Fury" } }));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_LANGUAGE: "schinese" });
  const m = await call(mc, "get_match", { match_id: 424242, include: { player_logs: true } });
  const byName = (slot) => m.players.find((p) => p.player_slot === slot);
  ok("radiant positions 1-5 assigned by lane + farm (no native field)", [0, 1, 2, 3, 4].map((s) => byName(s).position).join("") === "12345");
  ok("native position_est overrides the farm heuristic", [131, 129, 128, 130, 132].map((s) => byName(s).position).join("") === "12435", [131, 129, 128, 130, 132].map((s) => byName(s).position).join(""));
  ok("analyst fields surfaced (stuns/teamfight/towers/buyback)", byName(0).stuns === 2.5 && byName(0).teamfight_participation === 0.6 && byName(0).towers_killed === 2 && byName(0).buyback_count === 1);
  ok("lane labels localize (下路/上路 with schinese)", byName(128).lane === "下路" && byName(131).lane === "上路", `${byName(128).lane} / ${byName(131).lane}`);
  ok("role_summary is self-explanatory and localized", typeof byName(0).role_summary === "string" && /号位/.test(byName(0).role_summary), byName(0).role_summary);
  ok(
  "purchase_log entries carry item name (cost varies by patch)",
  byName(0).purchase_log?.[0]?.item === "狂战斧" && typeof byName(0).purchase_log?.[0]?.cost === "number",
  JSON.stringify(byName(0).purchase_log?.[0]),
);
  ok("kills_log victims resolved to hero names", byName(0).kills_log?.[0]?.victim?.name === "美杜莎", JSON.stringify(byName(0).kills_log?.[0]));
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression J — full field decoding (region/patch/towers/picks/sources)");
{
  const match = {
    match_id: 434343, radiant_win: true, radiant_score: 10, dire_score: 5, duration: 1500,
    start_time: 1700000000, game_mode: 22, lobby_type: 7, region: 1, patch: 60, version: 22,
    tower_status_radiant: 2047, tower_status_dire: 390, barracks_status_dire: 63,
    radiant_gold_adv: [100, -200],
    picks_bans: [{ is_pick: true, hero_id: 1, team: 0, order: 0 }, { is_pick: true, hero_id: 2, team: 1, order: 1 }],
    players: [{
      player_slot: 0, account_id: 7, personaname: 'q', hero_id: 1, kills: 1, deaths: 1, assists: 1, level: 10,
      radiant_win: true, duration: 1500, start_time: 1700000000, lane: 1, lane_role: 1, gold_per_min: 600,
      gold_reasons: { 12: 100, 6: 50 }, xp_reasons: { 1: 300 }, runes: { 5: 2 }, kill_streaks: { 3: 1 },
      max_hero_hit: { value: 500, key: 'npc_dota_hero_pudge', inflictor: 'phantom_assassin_coup_de_grace', time: 600 },
      permanent_buffs: [{ permanent_buff: 12, stack_count: 0, grant_time: 700 }],
    }],
  };
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/matches/434343") res.end(JSON.stringify(match));
    else if (path === "/constants/region") res.end(JSON.stringify({ 1: "US WEST" }));
    else if (path === "/constants/patch") res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
    else if (path === "/constants/permanent_buffs") res.end(JSON.stringify({ 12: "aghanims_shard" }));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${mock.address().port}/api`, OPENDOTA_LANGUAGE: "schinese" });
  const m = await call(mc, "get_match", { match_id: 434343, include: { breakdown: true } });
  const pl = m.players[0];
  ok("region decoded from match.region", m.region === "US WEST", m.region);
  ok("patch decoded", m.patch === "7.41", m.patch);
  ok("towers: all-standing mask decodes", m.radiant_towers_standing?.all_standing === true && m.radiant_towers_standing?.ancient_bottom === true);
  ok("towers: 390 leaves mid T1-T3 and ancients down", m.dire_towers_standing?.mid_t1 === false && m.dire_towers_standing?.mid_t3 === false && m.dire_towers_standing?.ancient_top === false && m.dire_towers_standing?.top_t2 === true);
  ok("picks_bans team 0/1 mapped to radiant/dire (non-CM drafts)", m.picks_bans[0].team === "radiant" && m.picks_bans[1].team === "dire", JSON.stringify(m.picks_bans.map(p => p.team)));
  ok("losing-team gold swing computed", m.losing_team_max_gold_lead === 200 && m.losing_team_max_gold_deficit === 100, `${m.losing_team_max_gold_lead}/${m.losing_team_max_gold_deficit}`);
  ok("gold sources labeled, undocumented key kept raw", pl.gold_sources?.Hero === 100 && pl.gold_sources?.reason_6 === 50, JSON.stringify(pl.gold_sources));
  ok("runes labeled (Bounty)", pl.runes?.Bounty === 2, JSON.stringify(pl.runes));
  ok("kill streaks labeled", pl.kill_streaks?.["Killing Spree"] === 1, JSON.stringify(pl.kill_streaks));
  ok("biggest hit resolves victim hero + inflictor", pl.biggest_hit?.on?.name_en === "Pudge" && typeof pl.biggest_hit?.with === "string", JSON.stringify(pl.biggest_hit));
  ok("permanent buff localized via item tables", pl.permanent_buffs?.[0]?.name === "阿哈利姆魔晶", JSON.stringify(pl.permanent_buffs));
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression K — official position port, firstblood resolution, facet decode");
{
  const g = (base) => Array.from({ length: 13 }, (_, i) => Math.round((i + 1) * base));
  const mk = (slot, heroId, laneRole, goldBase, lhBase, wards = 0, variant = 0) => ({
    player_slot: slot, account_id: 2000 + slot, personaname: `t${slot}`, hero_id: heroId,
    lane: laneRole === 2 ? 2 : slot < 5 ? 1 : 3, lane_role: laneRole, hero_variant: variant,
    gold_per_min: 600, kills: 1, deaths: 1, assists: 1, level: 20, radiant_win: true,
    duration: 1500, start_time: 1700000000, game_mode: 22, lobby_type: 7,
    gold_t: g(goldBase), lh_t: g(lhBase),
    purchase_log: wards > 0 ? [{ key: "ward_observer", time: 300 }] : [],
  });
  const match = {
    match_id: 444444, radiant_win: true, radiant_score: 9, dire_score: 9, duration: 1500,
    start_time: 1700000000, game_mode: 22, lobby_type: 7, region: 1,
    objectives: [{ time: 70, type: "CHAT_MESSAGE_FIRSTBLOOD", key: 7, player_slot: 0 }],
    players: [
      // Radiant: farm order by gold/lh windows -> pos 1..5, support with ward sinks to 5
      mk(0, 1, 1, 100, 50), // highest farm, safe -> 1
      mk(1, 2, 2, 80, 40), // mid -> 2
      mk(2, 3, 3, 60, 30), // off -> 3
      mk(3, 4, 3, 40, 20), // low farm, no ward -> 4
      mk(4, 5, 1, 20, 10, 1), // lowest farm + ward, safe -> 5
      // Dire mirror
      mk(128, 6, 1, 100, 50), mk(129, 7, 2, 80, 40), mk(130, 8, 3, 60, 30),
      mk(131, 9, 3, 40, 20), mk(132, 10, 1, 20, 10, 1, 2),
    ],
  };
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/matches/444444") res.end(JSON.stringify(match));
    else if (path === "/constants/hero_abilities")
      res.end(JSON.stringify({ npc_dota_hero_morphling: { facets: [{ id: 2, name: "morphling_shifty", title: "Shifty" }] } }));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${mock.address().port}/api` });
  const m = await call(mc, "get_match", { match_id: 444444, include: { objectives: true } });
  const rankPlayers = (m.players ?? []).filter((p) => p.early_farm_rank != null);
  ok("players carry early_farm_rank 1-5 (per team)", rankPlayers.length === 10 && rankPlayers.every((p) => p.early_farm_rank >= 1 && p.early_farm_rank <= 5), `${rankPlayers.length}/10`);
  const radiantRanks = rankPlayers.filter((p) => p.is_radiant).map((p) => p.early_farm_rank).sort().join(",");
  ok("early_farm_rank is a per-team 1-5 permutation", radiantRanks === "1,2,3,4,5", radiantRanks);
  ok("match view carries position_note legend", typeof m.position_note === "string" && m.position_note.includes("NOT the basis"));
  ok("official position port: farm order + ward tiebreak", [0, 1, 2, 3, 4].map((s) => m.players.find((p) => p.player_slot === s).position).join("") === "12345", [0, 1, 2, 3, 4].map((s) => m.players.find((p) => p.player_slot === s).position).join(""));
  ok("official position port (dire side)", [128, 129, 130, 131, 132].map((s) => m.players.find((p) => p.player_slot === s).position).join("") === "12345");
  const fb = m.objectives.find((o) => o.event === "First Blood");
  ok("firstblood resolved: killer by player_slot, victim by players index", fb?.killer?.name_en === "Anti-Mage" && fb?.victim?.name_en === "Juggernaut", JSON.stringify(fb));
  const direFive = m.players.find((p) => p.player_slot === 132);
  ok("facet resolved from hero_abilities constants", direFive?.facet?.title === "Shifty", JSON.stringify(direFive?.facet));
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression L — website-parity enrichments (fantasy/lane win/purchase time/chat target)");
{
  const g10 = Array.from({ length: 13 }, (_, i) => (i + 1) * 100); // gold_t[10] = 1100
  const mkP = (slot, lane, goldTen, extra = {}) => ({
    player_slot: slot, account_id: 3000 + slot, personaname: `w${slot}`, hero_id: 1,
    lane, kills: 10, deaths: 7, assists: 5, level: 25, radiant_win: true, last_hits: 136, denies: 1,
    gold_per_min: 1054, teamfight_participation: 0.6, obs_placed: 1, camps_stacked: 0,
    rune_pickups: 1, firstblood_claimed: 0, stuns: 0, towers_killed: 0, roshans_killed: 0,
    life_state_dead: 265, pings: 7, lane_kills: 40, ancient_kills: 2, observer_kills: 1,
    aghanims_shard: true, item_0: 1, lh_t: Array.from({ length: 13 }, (_, i) => i * 11), dn_t: Array.from({ length: 13 }, () => 0),
    purchase_time: { blink: 240 }, gold_t: Array.from({ length: 13 }, (_, i) => (i + 1) * (goldTen / 11)),
    ...extra,
  });
  // Radiant lane1 1100/900 (max 1100) vs dire 400/300 (max 400) -> won by 700;
  // lane3 radiant 500/600 (max 600) vs dire 1200/200 (max 1200) -> lost by 600.
  const players = [
    mkP(0, 1, 1100), mkP(1, 2, 1000), mkP(2, 3, 500), mkP(3, 1, 900), mkP(4, 3, 600),
    mkP(128, 1, 400), mkP(129, 2, 300), mkP(130, 3, 1200), mkP(131, 1, 300), mkP(132, 3, 200),
  ];
  const match = {
    match_id: 454545, radiant_win: true, radiant_score: 1, dire_score: 1, duration: 1500,
    start_time: 1700000000, game_mode: 22, lobby_type: 7,
    chat: [
      { time: 60, type: "chat", key: "hello all", player_slot: 0 },
      { time: 90, type: "chatwheel", key: "3", player_slot: 1 },
    ],
    players,
  };
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/matches/454545") res.end(JSON.stringify(match));
    else if (path === "/constants/chat_wheel") res.end(JSON.stringify({ 3: { id: 3, message: "Get Back!", all_chat: false } }));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${mock.address().port}/api` });
  const m = await call(mc, "get_match", { match_id: 454545, include: { chat: true } });
  const pa = m.players[0];
  ok("fantasy points match the official weights (8.97)", pa.fantasy_points === 8.97, pa.fantasy_points);
  ok("dead time formatted", pa.dead_time === "04:25", pa.dead_time);
  ok("pings and kill breakdown surfaced", pa.pings === 7 && pa.lane_creep_kills === 40 && pa.ancient_kills === 2 && pa.observer_ward_kills === 1);
  ok("aghanims flags surfaced", pa.has_aghanims_shard === true && pa.has_aghanims_scepter === undefined);
  ok("last hits/denies at 10 minutes", pa.last_hits_at_10 === 110 && pa.denies_at_10 === 0, `${pa.last_hits_at_10}/${pa.denies_at_10}`);
  ok("item purchase time attached", pa.items?.[0]?.purchased_at === "04:00" && pa.items?.[0]?.name_en === "Blink Dagger", JSON.stringify(pa.items?.[0]));
  ok("lane result: Story-tab max-gold@10 rule with draw threshold", m.players[0].lane_result === "won" && m.players[3].lane_result === "won" && m.players[8].lane_result === "lost" && m.players[2].lane_result === "lost" && m.players[9].lane_result === "won", [0,2,3,8,9].map(i => m.players[i].lane_result).join(","));
  const [textMsg, wheelMsg] = m.chat;
  ok("text chat targets all", textMsg.target === "all" && textMsg.message === "hello all");
  ok("chatwheel target from all_chat flag", wheelMsg.message === "Get Back!" && wheelMsg.target === "allies", JSON.stringify(wheelMsg));
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression M — unparsed match shape (basic data, degraded positions)");
{
  const match = {
    match_id: 464646, radiant_win: false, radiant_score: 15, dire_score: 31, duration: 1312,
    start_time: 1788034374, game_mode: 23, lobby_type: 0, region: 1, patch: 60,
    tower_status_radiant: 0, tower_status_dire: 2047, barracks_status_dire: 63,
    od_data: { has_api: true, has_gcdata: false, has_parsed: false },
    picks_bans: [{ is_pick: true, hero_id: 42, team: 1, order: 0 }, { is_pick: true, hero_id: 1, team: 0, order: 1 }],
    players: Array.from({ length: 10 }, (_, i) => ({
      player_slot: i < 5 ? i : 128 + (i - 5), account_id: 4000 + i, personaname: `u${i}`,
      hero_id: (i % 10) + 1, kills: i, deaths: 2, assists: 3, level: 20, last_hits: 50,
      gold_per_min: 600 + i * 100, item_neutral: 1605, item_neutral2: 1584, item_0: 1,
      radiant_win: false, duration: 1312, start_time: 1788034374, game_mode: 23,
    })),
  };
  const mock = (await import("node:http")).createServer((req, res) => {
    const path = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/matches/464646") res.end(JSON.stringify(match));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${mock.address().port}/api` });
  const m = await call(mc, "get_match", { match_id: 464646 });
  ok("unparsed flag surfaced with parse hint", m.parsed === false && /request_match_parse/.test(m.note ?? ""));
  ok("both neutral item slots resolved", m.players[0].neutral_item?.name_en === "Blink Dagger" || m.players[0].neutral_item != null, JSON.stringify(m.players[0].neutral_item));
  ok("positions degrade transparently to farm order", m.players.every((p) => p.position_basis === "farm_order_only") && m.players[5].position === 5, m.players.map((p) => p.position).join(""));
  ok("tower bitmask decodes on unparsed data", m.dire_towers_standing.all_standing === true && m.radiant_towers_standing.top_t1 === false);
  ok("non-CM picks_bans teams decoded", m.picks_bans[0].team === "dire" && m.picks_bans[1].team === "radiant");
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression N — bundle seed + patch probe + negative-lookup heal (request accounting)");
{
  // Probe throttling persists last_probe_at; clear before each boot so every scenario probes.
  const clearProbe = async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const mp = "constants-bundle/manifest.json";
    const m = JSON.parse(readFileSync(mp, "utf8"));
    delete m.last_probe_at;
    writeFileSync(mp, JSON.stringify(m, null, 2));
  };
  await clearProbe();
  const mkMatch = (heroId) => ({
    match_id: 474747, radiant_win: true, radiant_score: 5, dire_score: 5, duration: 1500,
    start_time: 1700000000, game_mode: 22, lobby_type: 7, region: 1, patch: 60,
    picks_bans: [], od_data: { has_parsed: false },
    players: Array.from({ length: 10 }, (_, i) => ({
      player_slot: i < 5 ? i : 128 + (i - 5), account_id: 5000 + i, hero_id: (i === 0) ? heroId : (i % 10) + 1,
      kills: 1, deaths: 1, assists: 1, level: 20, gold_per_min: 600, item_0: 1,
      radiant_win: true, duration: 1500, start_time: 1700000000, game_mode: 22,
    })),
  });
  const hits = [];
  let patchResponse = [{ id: 60, name: "7.41" }];
  let matchResponse = mkMatch(1);
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    hits.push(p);
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify(patchResponse));
    else if (p === "/matches/474747") res.end(JSON.stringify(matchResponse));
    else if (p.startsWith("/constants/")) res.end("{}");
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  // Per-scenario isolated tmpdir: match entries now persist to disk (parsed = 7 days),
  // so scenarios on the same mock port must not see each other's disk cache.
  const { mkdtempSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const scenarioTmp = () => {
    const t = mkdtempSync(pathMod.join(osMod.tmpdir(), "opendota-mcp-test-"));
    return { TMP: t, TEMP: t, TMPDIR: t };
  };
  const base = { OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_BUNDLE_SEED: "1", OPENDOTA_BUNDLE_PERSIST: "0" };

  // Scenario 1: probe matches bundled patch id -> cold boot + full get_match = exactly 2 requests
  {
    await clearProbe();
    const mc = await boot({ ...base, ...scenarioTmp() });
    await new Promise((r) => setTimeout(r, 500));
    hits.length = 0;
    const m = await call(mc, "get_match", { match_id: 474747, include: { breakdown: true, chat: true } });
    ok("probe-match: full get_match costs exactly 1 upstream request", hits.length === 1 && hits[0] === "/matches/474747", hits.join(","));
    ok("bundle-seeded enrichment still resolves names", m.players[1].hero?.name_en != null, JSON.stringify(m.players[1].hero));
    await mc.close();
  }

  // Scenario 2: probe sees a newer patch id -> all bundled constants refresh in background
  {
    patchResponse = [{ id: 99, name: "9.99" }];
    await clearProbe();
    const mc = await boot({ ...base, ...scenarioTmp() });
    await new Promise((r) => setTimeout(r, 800));
    const refreshed = hits.filter((h) => h.startsWith("/constants/") && h !== "/constants/patch");
    ok("stale bundle: probe triggers background refresh of bundled constants", refreshed.length >= 14, `${refreshed.length} refreshes: ${[...new Set(refreshed)].slice(0, 5).join(",")}…`);
    await mc.close();
    patchResponse = [{ id: 60, name: "7.41" }];
  }

  // Scenario 3: unknown hero id -> negative-lookup heal refreshes heroes once
  {
    await clearProbe();
    const mc = await boot({ ...base, ...scenarioTmp() });
    await new Promise((r) => setTimeout(r, 500));
    hits.length = 0;
    matchResponse = mkMatch(9999); // hero id absent from every table
    await call(mc, "get_match", { match_id: 474747 });
    await new Promise((r) => setTimeout(r, 400));
    ok("unknown hero id heals /constants/heroes exactly once", hits.filter((h) => h === "/constants/heroes").length === 1, JSON.stringify(hits));
    matchResponse = mkMatch(1);
    await mc.close();
  }
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression O — self-updating bundle (network refresh persists back to constants-bundle/)");
{
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  {
    const mp = "constants-bundle/manifest.json";
    const m = JSON.parse(readFileSync(mp, "utf8"));
    delete m.last_probe_at;
    writeFileSync(mp, JSON.stringify(m, null, 2));
  }
  const path = await import("node:path");
  let patchRespO = [{ id: 60, name: "7.41" }];
  const clearProbeO = async () => {
    const mp2 = "constants-bundle/manifest.json";
    const m2 = JSON.parse(readFileSync(mp2, "utf8"));
    delete m2.last_probe_at;
    writeFileSync(mp2, JSON.stringify(m2, null, 2));
  };
  const mockO = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify(patchRespO));
    else if (p === "/constants/heroes") res.end(JSON.stringify({ 1: { id: 1, localized_name: "Anti-Mage" } }));
    else res.end("{}");
  });
  await new Promise((r) => mockO.listen(0, "127.0.0.1", r));
  const portO = mockO.address().port;
  const manifestPath = path.resolve("constants-bundle/manifest.json");
  const patchPath = path.resolve("constants-bundle/patch.json");
  const savedManifest = readFileSync(manifestPath, "utf8");
  const savedPatch = readFileSync(patchPath, "utf8");
  try {
    patchRespO = [{ id: 123, name: "9.99" }];
    await clearProbeO();
    const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${portO}/api`, OPENDOTA_BUNDLE_SEED: "1", OPENDOTA_BUNDLE_PERSIST: "1" });
    await new Promise((r) => setTimeout(r, 800));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const patchData = JSON.parse(readFileSync(patchPath, "utf8"));
    ok("stale probe persists refreshed patch back into the bundle", patchData.some((p) => p.id === 123), JSON.stringify(patchData));
    ok("manifest max_patch_id advanced to the fetched value", manifest.max_patch_id === 123, JSON.stringify(manifest.max_patch_id));
    await mc.close();
  } finally {
    // A stale probe refreshes ALL bundled resources and persists them, so
    // restore the whole directory from git rather than individual files.
    try {
      (await import("node:child_process")).execSync("git checkout -- constants-bundle/", { stdio: "ignore" });
    } catch {
      writeFileSync(manifestPath, savedManifest);
      writeFileSync(patchPath, savedPatch);
    }
  }
  // Boot once more (probe back to matching) to confirm the restored bundle still seeds cleanly.
  patchRespO = [{ id: 60, name: "7.41" }];
  await clearProbeO();
  const mc2 = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${portO}/api`, OPENDOTA_BUNDLE_SEED: "1", OPENDOTA_BUNDLE_PERSIST: "0" });
  const m2 = await call(mc2, "get_constants", { resource: "heroes" });
  ok("bundle intact after restore", Object.keys(m2 ?? {}).length > 100);
  await mc2.close();
  mockO.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression P — hero kit / item details reference tools (bundle-served)");
{
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_BUNDLE_SEED: "1", OPENDOTA_BUNDLE_PERSIST: "0" });
  const kit = await call(mc, "get_hero_kit", { hero: "敌法师", language: "schinese" });
  ok("hero kit by localized name resolves", kit.hero?.name_en === "Anti-Mage", JSON.stringify(kit.hero));
  ok("kit carries all abilities with numbers", kit.abilities?.length >= 4 && kit.abilities[1].name_en === "Blink" && kit.abilities[1].cooldown != null, `${kit.abilities?.length} abilities`);
  ok("ability descriptions present", typeof kit.abilities[0].description === "string" && kit.abilities[0].description.length > 30, (kit.abilities[0].description ?? "").slice(0, 40));
  ok("talents listed without placeholder residue", kit.talents?.length >= 8 && !kit.talents.some((t) => /\{[sd]:/.test(t.name) || /^\s*[/+-]\s/.test(t.name)), kit.talents?.[2]?.name);
  const det = await call(mc, "get_item_details", { items: ["闪烁匕首", "bfury"], language: "schinese" });
  ok("item details by localized/internal name", det.items?.[0]?.name === "闪烁匕首" && det.items?.[0]?.cost === 2250, JSON.stringify(det.items?.[0]?.cost));
  ok("item effects and stats present", det.items?.[1]?.effects?.length >= 2 && det.items?.[1]?.stats?.some((s) => /Damage/i.test(s.label)), det.items?.[1]?.effects?.map((e) => e.title).join(","));
  const miss = await call(mc, "get_hero_kit", { hero: 99999 });
  ok("unknown hero returns error + hint", miss?.error != null && typeof miss.hint === "string");
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression Q — rank tiers always labeled (publicMatches avg rank, benchmarks bracket)");
{
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
    else if (p === "/publicMatches")
      res.end(
        JSON.stringify([
          { match_id: 111, radiant_win: true, duration: 2400, start_time: 1700000000, avg_rank_tier: 64, radiant_team: [1, 2], dire_team: [3, 4] },
          { match_id: 222, radiant_win: false, duration: 2100, start_time: 1700000060, avg_rank_tier: 80, radiant_team: [1, 2], dire_team: [3, 4] },
        ]),
      );
    else if (p === "/benchmarks") res.end(JSON.stringify({ hero_id: 1, result: { gold_per_min: [{ percentile: 0.5, value: 650 }] } }));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const mc = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_BUNDLE_SEED: "1", OPENDOTA_BUNDLE_PERSIST: "0" });
  const pub = await call(mc, "get_public_matches", { limit: 5 });
  ok("publicMatches avg_rank converted to medal label", pub.matches?.[0]?.avg_rank === "Ancient 4", JSON.stringify(pub.matches?.[0]?.avg_rank));
  ok("raw tier kept only as avg_rank_tier_raw", pub.matches?.[0]?.avg_rank_tier_raw === 64 && !("avg_rank_tier" in (pub.matches?.[0] ?? {})), JSON.stringify(pub.matches?.[0]));
  ok("top bracket labeled Immortal", pub.matches?.[1]?.avg_rank === "Immortal", JSON.stringify(pub.matches?.[1]?.avg_rank));
  const bm = await call(mc, "get_hero_benchmarks", { hero_id: 1, bracket: 6 });
  ok("benchmarks carries hero name + bracket label", bm.hero?.name_en === "Anti-Mage" && bm.bracket_label === "Ancient", JSON.stringify(bm.bracket_label));
  ok("benchmarks percentiles passed through", bm.benchmarks?.gold_per_min?.[0]?.value === 650, JSON.stringify(bm.benchmarks?.gold_per_min?.[0]));
  const bmAll = await call(mc, "get_hero_benchmarks", { hero_id: 1 });
  ok("benchmarks without bracket states its scope", /all public/.test(bmAll.bracket_label ?? ""), bmAll.bracket_label);
  const bmZh = await call(mc, "get_hero_benchmarks", { hero_id: 1, bracket: 6, language: "schinese" });
  ok("medal names localized (bracket 6 -> 万古流芳)", bmZh.bracket_label === "万古流芳", bmZh.bracket_label);
  const pubZh = await call(mc, "get_public_matches", { limit: 5, language: "schinese" });
  ok(
    "rank tier labels localized (64 -> 万古流芳 4)",
    pubZh.matches?.[0]?.avg_rank === "万古流芳 4",
    JSON.stringify(pubZh.matches?.[0]?.avg_rank),
  );
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression R — STRATZ provider (bracket/position aggregates; mock GraphQL upstream)");
{
  // Fresh temp dir so leftover STRATZ/OpenDota disk caches from other runs can't serve this section.
  const { mkdtempSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const freshTmp = mkdtempSync(pathMod.join(osMod.tmpdir(), "opendota-mcp-test-"));
  const isolatedEnv = { TMP: freshTmp, TEMP: freshTmp, TMPDIR: freshTmp };

  // Without a token none of the STRATZ tools register.
  const plain = await boot();
  const plainTools = (await plain.listTools()).tools;
  ok("no STRATZ token → STRATZ tools absent", !plainTools.some((t) => t.name === "get_matchups_by_rank"), `tools=${plainTools.length}`);
  await plain.close();

  let gqlHits = 0;
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") {
      res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
      return;
    }
    if (/^\/api\/matches\/\d+$/.test(p)) {
      // Two-player match for get_match_coaching: radiant wins; dire player 7654321 doubles bracket-avg deaths.
      res.end(
        JSON.stringify({
          radiant_win: true,
          duration: 1800,
          teamfights: [{ start: 600, end: 640, deaths: 2, players: [{ deaths: 1, gold_delta: 800, xp_delta: 300 }, { deaths: 1, gold_delta: -600, xp_delta: 0 }] }],
          objectives: [{ time: 700, type: "CHAT_MESSAGE_ROSHAN_KILL", team: 2 }],
          players: [
            { hero_id: 44, player_slot: 0, account_id: 1234, personaname: "A", level: 20, kills: 8, deaths: 4, assists: 6, hero_damage: 19600, tower_damage: 3800, gold_per_min: 600, rank_tier: 65 },
            { hero_id: 36, player_slot: 128, account_id: 7654321, personaname: "B", level: 16, kills: 3, deaths: 12, assists: 4, hero_damage: 25000, tower_damage: 1400, gold_per_min: 450, rank_tier: 65, damage: { npc_dota_hero_pudge: 5000, npc_dota_hero_medusa: 1000, illusion_npc_dota_hero_medusa: 9999, npc_dota_creep_badguys_melee: 3000 }, killed: { npc_dota_hero_pudge: 2 } },
          ],
        }),
      );
      return;
    }
    if (p === "/api/heroes/44/durations" || p === "/api/heroes/36/durations") {
      const h44 = p.includes("/44/");
      res.end(
        JSON.stringify(
          h44
            ? [{ duration_bin: 1500, games_played: 100, wins: 60 }, { duration_bin: 2400, games_played: 100, wins: 50 }, { duration_bin: 3300, games_played: 100, wins: 40 }]
            : [{ duration_bin: 1500, games_played: 100, wins: 45 }, { duration_bin: 2400, games_played: 100, wins: 50 }, { duration_bin: 3300, games_played: 100, wins: 55 }],
        ),
      );
      return;
    }
    if (p === "/graphql") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        gqlHits++;
        const q = String(JSON.parse(body).query ?? "");
        const send = (heroStats) => res.end(JSON.stringify({ data: { heroStats } }));
        if (q.includes("e0:")) {
          // get_draft_advice: enemy 44 and 2 both lose to candidate 80; picked heroes excluded.
          send({
            e0: { disadvantage: [{ vs: [{ heroId2: 80, matchCount: 250, winCount: 75 }, { heroId2: 2, matchCount: 900, winCount: 100 }] }] },
            e1: { disadvantage: [{ vs: [{ heroId2: 80, matchCount: 400, winCount: 160 }] }] },
            // matchUp returns one dryad per queried ally — keep the real array shape.
            synergy: [{ with: [{ heroId2: 80, matchCount: 500, winCount: 300, synergy: 5 }] }],
          });
        } else if (q.includes("heroVsHeroMatchup")) {
          send({
            heroVsHeroMatchup: {
              advantage: [{ heroId: 44, vs: [{ heroId2: 66, matchCount: 250, winCount: 163 }] }],
              disadvantage: [{ heroId: 44, vs: [{ heroId2: 78, matchCount: 300, winCount: 105 }] }],
            },
          });
        } else if (q.includes("itemFullPurchase")) {
          // `time` is minutes in the STRATZ API.
          send({ itemFullPurchase: [{ itemId: 1, time: 10, matchCount: 100, winCount: 60 }, { itemId: 1, time: 13, matchCount: 50, winCount: 25 }] });
        } else if (q.includes("winGameVersion")) {
          send({ winGameVersion: [{ gameVersionId: 200, winCount: 55, matchCount: 100 }, { gameVersionId: 199, winCount: 40, matchCount: 100 }] });
        } else if (q.includes("gameVersions")) {
          res.end(JSON.stringify({ data: { constants: { gameVersions: [{ id: 200, name: "7.99" }, { id: 199, name: "7.98" }] } } }));
          return;
        } else if (q.includes("groupByPosition")) {
          send({
            stats: [
              { heroId: 44, position: "POSITION_1", matchCount: 1000, winCount: 550, level: 22, kills: 9, deaths: 5, assists: 7, heroDamage: 19000, physicalDamage: 18000, magicalDamage: 30, towerDamage: 3900, campsStacked: 0.6 },
              { heroId: 44, position: "POSITION_4", matchCount: 50, winCount: 15, level: 18, kills: 6, deaths: 9, assists: 11, heroDamage: 13000, physicalDamage: 12000, magicalDamage: 46, towerDamage: 970, campsStacked: 0.5 },
            ],
          });
        } else if (q.includes("stats(heroIds")) {
          send({
            stats: [
              { heroId: 44, matchCount: 11008, winCount: 5994, level: 22, kills: 9, deaths: 5, assists: 7, heroDamage: 19621, physicalDamage: 18250, magicalDamage: 27, towerDamage: 3874, disableDuration: 5, healingAllies: 0.1, networth: 20019 },
              { heroId: 36, matchCount: 29993, winCount: 14788, level: 20, kills: 5, deaths: 5, assists: 8, heroDamage: 25205, physicalDamage: 2640, magicalDamage: 15792, towerDamage: 1495, disableDuration: 65, healingAllies: 4565, networth: 19493 },
            ],
          });
        } else if (q.includes("abilityMinLevel")) {
          res.end(
            JSON.stringify({
              data: {
                heroStats: {
                  mn: [
                    { abilityId: 5190, level: 1, matchCount: 100, winCount: 50 },
                    { abilityId: 483, level: 10, matchCount: 999, winCount: 500 },
                  ],
                  mx: [{ abilityId: 5190, level: 7, matchCount: 40, winCount: 24 }],
                },
              },
            }),
          );
          return;
        } else if (q.includes("talent")) {
          send({ talent: [{ abilityId: 483, matchCount: 1000, winCount: 600 }] });
        } else {
          res.end(JSON.stringify({ data: {}, errors: [{ message: "unknown mock query" }] }));
        }
      });
      return;
    }
    res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;

  const sc = await boot({
    ...isolatedEnv,
    STRATZ_API_TOKEN: "dummy-token",
    STRATZ_BASE_URL: `http://127.0.0.1:${port}/graphql`,
    OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`,
    OPENDOTA_BUNDLE_SEED: "1",
    OPENDOTA_BUNDLE_PERSIST: "0",
  });
  const scTools = (await sc.listTools()).tools;
  ok("STRATZ token → 66 tools", scTools.length === 66, `got ${scTools.length}`);
  for (const n of ["get_matchups_by_rank", "get_item_builds_by_rank", "get_talent_stats", "get_lane_matchups", "get_draft_advice", "get_skill_builds_by_rank", "get_hero_position_stats", "get_draft_composition", "get_match_coaching", "get_hero_trend"]) {
    ok(`registers ${n}`, scTools.some((t) => t.name === n));
  }

  const hitsBefore = gqlHits;
  const mu = await call(sc, "get_matchups_by_rank", { hero: "幻影刺客", bracket: "divine_immortal", take: 3, language: "schinese" });
  ok(
    "matchups by rank: recomputed WR + ci95 + bracket label",
    mu.strong_against?.[0]?.win_rate_pct === 65.2 && mu.strong_against?.[0]?.games === 250 && typeof mu.strong_against?.[0]?.win_rate_ci95_pp === "number",
    head(mu.strong_against?.[0]),
  );
  ok("struggles list computed from losses", mu.struggles_against?.[0]?.win_rate_pct === 35, head(mu.struggles_against?.[0]));
  ok("bracket label present (localized)", mu.bracket === "超凡入圣–冠绝一世（高分段）", mu.bracket);
  ok("source attribution", mu.source === "stratz.com");

  const items = await call(sc, "get_item_builds_by_rank", { hero: 44, limit: 5 });
  const bf = items.items?.[0];
  ok(
    "item builds: aggregated games/avg minute/WR across timing buckets",
    bf?.games === 150 && bf?.avg_purchase_min === 11 && bf?.win_rate_pct === 56.7 && typeof bf?.item === "string",
    head(bf),
  );

  const tal = await call(sc, "get_talent_stats", { hero: 44 });
  ok(
    "talent stats resolve real talent names with counts",
    tal.talents?.[0]?.games === 1000 && tal.talents?.[0]?.win_rate_pct === 60 && typeof tal.talents?.[0]?.talent === "string" && !tal.talents[0].talent.includes("{"),
    head(tal.talents?.[0]),
  );

  const draft = await call(sc, "get_draft_advice", { enemy_heroes: [44, 2], ally_heroes: [11], bracket: "divine_immortal", take: 3 });
  const rec = draft.recommendations?.[0];
  ok(
    "draft advice: candidate countering both enemies with per-enemy WR",
    rec?.enemies_countered === 2 && rec?.counters?.length === 2 && rec?.counters?.[0]?.win_rate_pct === 70,
    head(rec),
  );
  ok("draft advice: picked heroes never recommended", draft.recommendations?.length === 1, head(draft.recommendations?.map((r) => r.hero)));
  ok("draft advice: ally synergy attached", rec?.ally_synergy?.[0]?.games === 500 && rec?.ally_synergy?.[0]?.win_rate_pct === 60, head(rec?.ally_synergy));

  const trend = await call(sc, "get_hero_trend", { hero: 44, patches: 2 });
  ok(
    "hero trend: patch names mapped + delta vs previous patch",
    trend.by_patch?.[0]?.patch === "7.99" && trend.by_patch?.[0]?.win_rate_pct === 55 && trend.by_patch?.[0]?.delta_vs_prev_patch_pp === 15,
    head(trend.by_patch),
  );

  // Identical aggregates are served from cache — one upstream GraphQL call per unique query.
  await call(sc, "get_matchups_by_rank", { hero: "幻影刺客", bracket: "divine_immortal", take: 3, language: "schinese" });
  ok("stratz responses cached (no duplicate upstream query)", gqlHits - hitsBefore === 6, `gql calls since boot section: ${gqlHits - hitsBefore}`);

  const sb = await call(sc, "get_skill_builds_by_rank", { hero: 44, bracket: "divine_immortal" });
  const dagger = sb.abilities?.find((a) => /dagger/i.test(a.ability));
  ok(
    "skill builds: first point + maxed level with share",
    dagger?.first_point?.hero_level === 1 && dagger?.first_point?.share_pct === 100 && dagger?.maxed?.hero_level === 7 && dagger?.maxed?.win_rate_pct === 60,
    head(dagger),
  );
  ok("skill builds: talents excluded from ability list", !sb.abilities?.some((a) => /phantom_assassin_4|talent/i.test(a.ability)), sb.abilities?.map((a) => a.ability).join(","));

  const pos = await call(sc, "get_hero_position_stats", { hero: 44 });
  ok(
    "position stats: per-position WR + most played",
    pos.most_played?.position === 1 && pos.most_played?.win_rate_pct === 55 && pos.positions?.[0]?.games === 1000,
    head(pos.most_played),
  );

  const comp = await call(sc, "get_draft_composition", { team_heroes: [44], enemy_heroes: [36] });
  ok("composition: enemy damage mix computed", comp.enemy?.totals?.magical_damage_pct === 86, JSON.stringify(comp.enemy?.totals));
  ok("composition: timing windows from duration curves", comp.yours?.totals?.late_win_rate_pct === 40 && comp.enemy?.totals?.late_win_rate_pct === 55, JSON.stringify(comp.yours?.totals));
  ok(
    "composition: coaching notes generated",
    comp.coach_notes?.some((n) => /Pipe|BKB/.test(n)) && comp.coach_notes?.some((n) => /outscale|sustain|healing/i.test(n)),
    head(comp.coach_notes),
  );

  const coach = await call(sc, "get_match_coaching", { match_id: 999, focus_account_id: 7654321 });
  ok("match coaching: bracket detected from medals", /Legend–Ancient/.test(coach.bracket ?? ""), coach.bracket);
  ok(
    "match coaching: loser flagged against bracket averages",
    coach.players_vs_bracket_avg?.some((p) => p.account_id === 7654321 && p.focus === true && (p.vs_bracket_avg_pct?.deaths ?? 0) > 50),
    JSON.stringify(coach.players_vs_bracket_avg?.find((p) => p.account_id === 7654321)?.vs_bracket_avg_pct),
  );
  ok("match coaching: timing verdict present", typeof coach.timing_verdict === "string" && coach.timing_verdict.length > 20, head(coach.timing_verdict));  ok(
    "match coaching: damage targets resolved, illusions excluded",
    coach.players_vs_bracket_avg?.some((p) => p.hero_damage_on?.top_targets?.[0]?.hero === "Pudge" && p.hero_damage_on.top_targets.every((t) => !/illusion/i.test(t.hero)) && p.hero_damage_on.total === 6000),
    JSON.stringify(coach.players_vs_bracket_avg?.find((p) => p.account_id === 7654321)?.hero_damage_on),
  );
  ok("match coaching: decisive teamfight + roshan timeline", coach.decisive_teamfights?.[0]?.at_min === 10 && coach.objective_timeline?.roshans?.[0]?.team === "radiant", JSON.stringify(coach.decisive_teamfights));


  await sc.close();

  // Token failures become {error, hint} results, not protocol errors.
  const deny = (await import("node:http")).createServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ message: "A bearer token is required for a request." }));
  });
  await new Promise((r) => deny.listen(0, "127.0.0.1", r));
  const sc2 = await boot({
    ...isolatedEnv,
    STRATZ_API_TOKEN: "expired",
    STRATZ_BASE_URL: `http://127.0.0.1:${deny.address().port}/graphql`,
    OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`,
    OPENDOTA_BUNDLE_SEED: "1",
  });
  const err = await call(sc2, "get_hero_trend", { hero: 44 });
  ok("401 → friendly error + renewal hint", /token/i.test(err.error ?? "") && /stratz.com\/api/.test(err.hint ?? ""), head(err));
  await sc2.close();
  deny.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression S — install-skill CLI copies the Agent Skill into host dirs");
{
  const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(pathMod.join(osMod.tmpdir(), "skill-test-"));
  const r = spawnSync(process.execPath, ["dist/index.js", "install-skill", "all"], {
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
    encoding: "utf8",
  });
  ok("install-skill exits 0", r.status === 0, (r.stderr || "").slice(0, 120));
  ok("claude-code dir populated", existsSync(pathMod.join(tmp, ".claude", "skills", "opendota", "SKILL.md")));
  ok("zcode dir populated", existsSync(pathMod.join(tmp, ".agents", "skills", "opendota", "SKILL.md")));
  ok(
    "copied SKILL.md keeps its front-matter",
    readFileSync(pathMod.join(tmp, ".agents", "skills", "opendota", "SKILL.md"), "utf8").includes("name: opendota"),
  );
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression T — item win rate vs a specific enemy (explorer cross-tab)");
{
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") {
      res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
      return;
    }
    if (p === "/explorer") {
      const sql = decodeURIComponent(req.url.split("sql=")[1] ?? "").replaceAll("+", " ");
      const rowsFor = () => {
        if (sql.includes("UNNEST")) return [{ item_id: 116, games: 100, wins: 55 }];
        if (sql.includes("NOT IN")) return [{ games: 200, wins: 90 }];
        if (sql.includes(" IN (")) return [{ games: 100, wins: 60 }];
        return [{ games: 300, wins: 150 }]; // baseline
      };
      res.end(JSON.stringify({ rows: rowsFor() }));
      return;
    }
    res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const { mkdtempSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const freshTmp = mkdtempSync(pathMod.join(osMod.tmpdir(), "opendota-mcp-test-"));
  const mc = await boot({
    TMP: freshTmp,
    TEMP: freshTmp,
    TMPDIR: freshTmp,
    OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`,
    OPENDOTA_BUNDLE_SEED: "1",
    OPENDOTA_BUNDLE_PERSIST: "0",
  });
  const cmp = await call(mc, "get_item_winrate_vs_hero", { hero_id: 106, enemy_hero_id: 36, item: "Black King Bar" });
  ok(
    "with/without cross-tab computed",
    cmp.with_item?.games === 100 && cmp.with_item?.win_rate_pct === 60 && cmp.without_item?.win_rate_pct === 45,
    head(cmp),
  );
  ok("delta_pp = treatment - control", cmp.delta_pp === 15, String(cmp.delta_pp));
  ok("item resolved by English display name", typeof cmp.item === "string" && cmp.item.length > 0, cmp.item);
  ok("low_sample annotation on cells", cmp.with_item?.low_sample === true, JSON.stringify(cmp.with_item));
  const lst = await call(mc, "get_item_winrate_vs_hero", { hero_id: 106, enemy_hero_id: 36 });
  ok("list mode returns ranked items + baseline", lst.items?.[0]?.games === 100 && lst.baseline?.win_rate_pct === 50, head(lst.items?.[0]));
  const miss = await call(mc, "get_item_winrate_vs_hero", { hero_id: 106, enemy_hero_id: 36, item: "zzz_no_such_item" });
  ok("unknown item → error + hint", miss?.error != null && typeof miss.hint === "string", head(miss));
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression U — social tools: duo peers + repeat opponents");
{
  const mkMatch = (id, radiantWin, foeHero, together = false) => ({
    match_id: id,
    radiant_win: radiantWin,
    start_time: 1700000000 + id,
    players: [
      { account_id: 1, player_slot: 0, hero_id: 44 },
      { account_id: 2, player_slot: together ? 1 : 128, hero_id: foeHero, personaname: "Foe", rank_tier: 80 },
    ],
  });
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
    else if (p === "/players/1/peers")
      res.end(JSON.stringify([{ account_id: 9, personaname: "Pal", games: 10, win: 6, with_games: 10, with_win: 6, with_gpm_sum: 5000, with_xpm_sum: 6000, last_played: 1700000000 }]));
    else if (p === "/players/1/matches") res.end(JSON.stringify([{ match_id: 101 }, { match_id: 102 }, { match_id: 103 }]));
    else if (p === "/matches/101") res.end(JSON.stringify(mkMatch(101, true, 2)));
    else if (p === "/matches/102") res.end(JSON.stringify(mkMatch(102, false, 3)));
    else if (p === "/matches/103") res.end(JSON.stringify(mkMatch(103, true, 3, true)));
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const { mkdtempSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const freshTmp = mkdtempSync(pathMod.join(osMod.tmpdir(), "opendota-mcp-test-"));
  const mc = await boot({
    TMP: freshTmp, TEMP: freshTmp, TMPDIR: freshTmp,
    OPENDOTA_BASE_URL: `http://127.0.0.1:${mock.address().port}/api`,
    OPENDOTA_BUNDLE_SEED: "1",
    OPENDOTA_BUNDLE_PERSIST: "0",
  });
  const peers = await call(mc, "get_player_peers", { account_id: 1 });
  ok(
    "peers: duo win rate + together averages computed",
    peers[0]?.as_duo?.win_rate_pct === 60 && peers[0]?.as_duo?.avg_gpm_while_together === 500,
    JSON.stringify(peers[0]?.as_duo),
  );
  const opp = await call(mc, "get_player_opponents", { account_id: 1, limit_matches: 10 });
  const foe = opp.repeat_opponents?.[0];
  ok(
    "opponents: repeat enemy aggregated across scanned matches",
    foe?.player === "Foe" && foe?.encounters === 2 && foe?.my_win_rate_pct === 50 && foe?.rank_tier === "Immortal",
    JSON.stringify(foe).slice(0, 200),
  );
  ok(
    "opponents: their hero list vs me resolved",
    foe?.their_heroes_vs_me?.length === 2 && typeof foe?.their_heroes_vs_me?.[0]?.hero === "string",
    JSON.stringify(foe?.their_heroes_vs_me),
  );
  const partner = await call(mc, "get_player_partnership", { account_id: 1, peer_account_id: 2, limit_matches: 10, min_hero_games: 1 });
  ok(
    "partnership: together vs against split",
    partner.together?.games === 1 && partner.together?.win_rate_pct === 100 && partner.against_each_other?.games === 2 && partner.against_each_other?.win_rate_pct === 50,
    JSON.stringify({ t: partner.together?.games, a: partner.against_each_other?.games }),
  );
  await mc.close();
  mock.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n■ Regression W — tiered cache: parsed matches are long-cached and disk-persistent");
{
  const hitCount = { 777: 0, 778: 0 };
  const mkMatch = (id, parsed) => ({
    match_id: id,
    ...(parsed ? { version: 246 } : {}),
    radiant_win: true,
    duration: 2000,
    start_time: 1700000000,
    players: [
      { player_slot: 0, account_id: 1, hero_id: 1, kills: 2, deaths: 1, assists: 3, gold_per_min: 400, xp_per_min: 400, last_hits: 100 },
      { player_slot: 128, account_id: 2, hero_id: 2, kills: 1, deaths: 2, assists: 3, gold_per_min: 380, xp_per_min: 380, last_hits: 90 },
    ],
  });
  const mock = (await import("node:http")).createServer((req, res) => {
    const p = req.url.replace(/^\/api/, "").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (p === "/constants/patch") res.end(JSON.stringify([{ id: 60, name: "7.41" }]));
    else if (p === "/matches/777") { hitCount[777]++; res.end(JSON.stringify(mkMatch(777, true))); }
    else if (p === "/matches/778") { hitCount[778]++; res.end(JSON.stringify(mkMatch(778, false))); }
    else res.end("{}");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const { mkdtempSync } = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const freshTmp = mkdtempSync(pathMod.join(osMod.tmpdir(), "opendota-mcp-test-"));
  const env = {
    TMP: freshTmp, TEMP: freshTmp, TMPDIR: freshTmp,
    OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`,
    OPENDOTA_BUNDLE_SEED: "1",
    OPENDOTA_BUNDLE_PERSIST: "0",
  };
  const a = await boot(env);
  await call(a, "get_match", { match_id: 777 });
  await call(a, "get_match", { match_id: 777 });
  ok("parsed match: second read served from memory (1 upstream)", hitCount[777] === 1, String(hitCount[777]));
  await call(a, "get_match", { match_id: 778 });
  await call(a, "get_match", { match_id: 778 });
  ok("unparsed match: cached within its short window too", hitCount[778] === 1, String(hitCount[778]));
  await a.close();
  const b = await boot(env);
  const m = await call(b, "get_match", { match_id: 777 });
  ok("parsed match survives a process restart via disk cache (still 1 upstream)", hitCount[777] === 1 && m.match_id === 777, String(hitCount[777]));
  // Position evidence: the response must explain its own position numbers.
  ok("parsed match carries position_note legend", typeof m.position_note === "string" && m.position_note.includes("minutes 10-12"));
  await b.close();
  mock.close();
}

console.log("\n■ Y: player overview dashboard");
{
if (!LIVE) {
  console.log("  (skipped: live API required)");
} else {  const yClient = await boot({ OPENDOTA_LANGUAGE: "schinese" });
  const ov = await call(yClient, "get_player_overview", { account_id: 48645517, language: "schinese", recent: 10 });
  ok("overview: player block with localized rank", typeof ov.player?.rank_tier === "string" && ov.player.rank_tier.length > 0, ov.player?.rank_tier);
  const firstMode = ov.volume?.by_mode?.[0]?.mode;
  ok("overview: volume with named modes", ov.volume?.total_games > 0 && typeof firstMode === "string" && !/^\d+$/.test(firstMode), String(firstMode));
  ok("overview: recent form computed", ov.recent_form?.window > 0 && typeof ov.recent_form.win_rate_pct === "number" && /^\d+[WL]$/.test(ov.recent_form.current_streak ?? ""), ov.recent_form?.current_streak);
  ok("overview: hero pool with signature flags", Array.isArray(ov.hero_pool) && ov.hero_pool.length > 0 && typeof ov.hero_pool[0].games === "number" && typeof ov.hero_pool[0].signature === "boolean");
  ok("overview: lane distribution excludes unknown with coverage note", Array.isArray(ov.lane_distribution?.lanes) && ov.lane_distribution.lanes.every((l) => l.lane_role !== "Unknown") && typeof ov.lane_distribution.note === "string");
  ok("overview: context note guides drill-down", typeof ov.context_note === "string" && ov.context_note.includes("get_player_partnership"));

  const an = await call(yClient, "get_player_match_analytics", { account_id: 48645517, limit: 50, language: "schinese" });
  ok("analytics: window + overall computed", an.window?.games >= 40 && typeof an.overall?.win_rate_pct === "number" && /^\d+[WL]$/.test(an.overall.current_streak ?? ""), an.overall?.current_streak);
  ok("analytics: streak sane (<= window)", (an.overall?.current_streak ?? "0W").slice(0, -1) <= an.window.games);
  ok("analytics: halves trend present", typeof an.trend?.first_half_win_rate_pct === "number" && typeof an.trend.second_half_win_rate_pct === "number");
  ok("analytics: hero table localized + kda", Array.isArray(an.by_hero) && an.by_hero.length > 0 && typeof an.by_hero[0].avg_kda === "number" && !/^hero \d+$/.test(an.by_hero[0].hero), an.by_hero?.[0]?.hero);
  ok("analytics: recent slim list for drill-down", Array.isArray(an.recent_matches) && an.recent_matches.length > 0 && typeof an.recent_matches[0].match_id === "number");
  ok("analytics: compact response (context safety)", JSON.stringify(an).length < 8000);

  const aug = await call(yClient, "get_player_match_analytics", { account_id: 48645517, from: "2026-08-01", to: "2026-08-31", language: "schinese" });
  ok("analytics: month window filters correctly", aug.window?.games > 0 && aug.window.days_spanned <= 31 && aug.window.coverage === "complete", `${aug.window?.games} games / ${aug.window?.days_spanned}d`);
  const badDate = await expectError(yClient, "get_player_match_analytics", { account_id: 48645517, from: "not-a-date" });
  ok("analytics: bad date rejected with hint", badDate.isError || JSON.parse(badDate.text).error != null);

  const page2 = await call(yClient, "get_player_match_analytics", { account_id: 48645517, limit: 50, offset: 50 });
  const page1ids = new Set(an.recent_matches.map((m) => m.match_id));
  ok(
    "analytics: offset pages backward without overlap",
    page2.window?.offset_applied === 50 && page2.window.games > 0 && page2.recent_matches.every((m) => !page1ids.has(m.match_id)),
    `offset=${page2.window?.offset_applied} games=${page2.window?.games}`,
  );
  await yClient.close();
}
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
console.log("\n■ X: community nickname aliases (黑话)");
{
  // X1: builtin table integrity — every target must exist in current constants.
  const [aliasesMod, constantsMod, localesMod] = await Promise.all([
    import("../dist/aliases.js"),
    import("../dist/constants.js"),
    import("../dist/locales.js"),
  ]);
  const validHeroes = new Set(
    Object.values(localesMod.getLocaleBundle("english").heroes).map((e) => e.internal.replace(/^npc_dota_hero_/, "")),
  );
  const validItems = new Set(Object.values(await constantsMod.getItemIds()).map(String));
  let bad = [];
  for (const [a, t] of Object.entries(aliasesMod.BUILTIN_HERO_ALIASES)) if (!validHeroes.has(t)) bad.push(`hero ${a}->${t}`);
  for (const [a, t] of Object.entries(aliasesMod.BUILTIN_ITEM_ALIASES)) if (!validItems.has(t)) bad.push(`item ${a}->${t}`);
  for (const [a, ts] of Object.entries(aliasesMod.BUILTIN_AMBIGUOUS_HEROES)) {
    for (const t of ts) if (!validHeroes.has(t)) bad.push(`ambiguous ${a}->${t}`);
  }
  ok("builtin alias tables: every target exists in current constants", bad.length === 0, bad.slice(0, 4).join("; "));
  ok("builtin coverage is substantial", Object.keys(aliasesMod.BUILTIN_HERO_ALIASES).length >= 100 && Object.keys(aliasesMod.BUILTIN_ITEM_ALIASES).length >= 50);

  // The long-lived `client` from Boot #1 may already be closed by earlier sections —
  // X runs on its own instance.
  const xClient = await boot({ OPENDOTA_LANGUAGE: "schinese" });

  // X2: hero nicknames resolve through search (exact hit ranked first, marked via:nickname).
  const ember = await call(xClient, "search_dota_entities", { query: "火猫", language: "schinese" });
  const emberHit = ember.matches?.find((m) => m.kind === "hero" && m.id === 106 && m.via === "nickname");
  ok("火猫 -> Ember Spirit (106) via nickname", !!emberHit, head(ember));
  const sb = await call(xClient, "get_hero_kit", { hero: "白牛", language: "schinese" });
  ok("get_hero_kit(白牛) -> Spirit Breaker kit", sb.hero?.id === 71 || sb.hero?.name_en === "Spirit Breaker", head(sb.hero ?? sb));

  // X3: item nicknames + EN codes resolve.
  const vessel = await call(xClient, "search_dota_entities", { query: "大骨灰", language: "schinese" });
  const vesselHit = vessel.matches?.find((m) => m.kind === "item" && m.internal === "spirit_vessel");
  ok("大骨灰 -> spirit_vessel via nickname", !!vesselHit, head(vessel));
  const od = await call(xClient, "get_hero_kit", { hero: "od", language: "schinese" });
  ok("od (EN code) -> Outworld Destroyer", od.hero?.name_en === "Outworld Destroyer", head(od.hero ?? od));

  // X4: ambiguous nicknames never guess — candidates are returned for the agent to ask.
  const mk = await call(xClient, "search_dota_entities", { query: "猴子", language: "schinese" });
  const ambIds = (mk.ambiguous?.candidates ?? []).map((c) => c.id).sort((a, b) => a - b);
  ok("猴子 -> ambiguous with PL + MK candidates", !!mk.ambiguous && ambIds.length === 2 && ambIds.join(",") === "12,114", head(mk));
  const kitAmb = await expectError(xClient, "get_hero_kit", { hero: "猴子", language: "schinese" });
  ok("get_hero_kit(猴子) errors with candidates instead of guessing", kitAmb.isError || JSON.parse(kitAmb.text).ambiguous != null, head(kitAmb.text));

  // X5: user extension file — custom aliases win, invalid targets are dropped silently.
  const { mkdtempSync: mkAliasDir, writeFileSync: wfAlias } = await import("node:fs");
  const aliasDir = mkAliasDir((await import("node:path")).join((await import("node:os")).tmpdir(), "opendota-mcp-aliases-"));
  const aliasFile = (await import("node:path")).join(aliasDir, "aliases.json");
  wfAlias(aliasFile, JSON.stringify({
    heroes: { 我的本命: "ember_spirit", 坏条目: "not_a_real_hero" },
    items: { 我的道具: "blink" },
  }));
  const aClient = await boot({ OPENDOTA_ALIASES_FILE: aliasFile, OPENDOTA_LANGUAGE: "schinese" });
  const customHero = await call(aClient, "search_dota_entities", { query: "我的本命" });
  const customItem = await call(aClient, "search_dota_entities", { query: "我的道具" });
  const broken = await call(aClient, "search_dota_entities", { query: "坏条目" });
  const builtinStill = await call(aClient, "search_dota_entities", { query: "火猫" });
  ok("user alias file: custom hero alias resolves", customHero.matches?.[0]?.id === 106, head(customHero));
  ok("user alias file: custom item alias resolves", customItem.matches?.[0]?.internal === "blink", head(customItem));
  ok("user alias file: invalid target dropped without breaking boot", (broken.matches ?? []).length === 0);
  ok("user alias file: builtin aliases still active", builtinStill.matches?.[0]?.id === 106);
  await aClient.close();
  await xClient.close();
}

// ─────────────────────────────────────────────────────────────
console.log(`\n═══ 结果: ${passed} passed, ${failed} failed ═══`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
process.exit(0);

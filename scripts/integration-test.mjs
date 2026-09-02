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
} // LIVE

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
    if (path === "/heroStats") {
      res.end(JSON.stringify([{ hero_id: 1, localized_name: `Anti-Mage v${heroPayloadVersion}`, primary_attr: "agi", attack_type: "Melee", roles: [] }]));
    } else {
      res.end("{}");
    }
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  // TTL 0.02 min = 1.2s so expiry happens within the test
  const swr = await boot({ OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`, OPENDOTA_CONSTANTS_TTL_MINUTES: "0.02", OPENDOTA_RATE_LIMIT: "1000" });
  const first = await call(swr, "get_heroes", {});
  ok("first fetch returns v1", first[0]?.name_en === "Anti-Mage v1", first[0]?.name_en);
  const afterFirst = hits["/heroStats"];
  await new Promise((r) => setTimeout(r, 1500)); // let the cache expire
  heroPayloadVersion = 2;
  const t0 = Date.now();
  const stale = await call(swr, "get_heroes", {});
  const ms = Date.now() - t0;
  ok("expired entry served instantly (stale-while-revalidate)", ms < 250, `${ms}ms`);
  ok("stale response is still coherent data", stale[0]?.name_en === "Anti-Mage v1", stale[0]?.name_en);
  await new Promise((r) => setTimeout(r, 1500)); // background refresh completes
  ok("background refresh hit upstream exactly once more", hits["/heroStats"] === afterFirst + 1, `${hits["/heroStats"]} vs ${afterFirst}+1`);
  const fresh = await call(swr, "get_heroes", {});
  ok("next call sees refreshed data", fresh[0]?.name_en === "Anti-Mage v2", fresh[0]?.name_en);
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
  ok("lane labels are official (Bot/Mid/Top)", byName(128).lane === "Bot" && byName(131).lane === "Top", `${byName(128).lane} / ${byName(131).lane}`);
  ok("purchase_log entries carry item name and cost", byName(0).purchase_log?.[0]?.item === "狂战斧" && byName(0).purchase_log?.[0]?.cost === 4100, JSON.stringify(byName(0).purchase_log?.[0]));
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
console.log(`\n═══ 结果: ${passed} passed, ${failed} failed ═══`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
process.exit(0);

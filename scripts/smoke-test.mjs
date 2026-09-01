/**
 * Smoke test: boot the built server over stdio, list tools, and make real calls.
 * Run: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

function head(json, n = 400) {
  const s = typeof json === "string" ? json : JSON.stringify(json);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 1. List tools
const { tools } = await client.listTools();
console.log(`[1] listTools: ${tools.length} tools`);
console.log(`    ${tools.map((t) => t.name).join(", ")}`);

async function call(name, args, label) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${label} failed: ${text}`);
  console.log(`\n[${label}]`);
  console.log(head(text, 700));
  return JSON.parse(text);
}

// 2. Entity search in Chinese
const search = await call(
  "search_dota_entities",
  { query: "敌法师", language: "schinese" },
  "2] search_dota_entities(敌法师)",
);
const amId = search.matches?.find((m) => m.kind === "hero")?.id;

// 3. Heroes list in Chinese
const heroes = await call("get_heroes", { language: "zh-CN" }, "3] get_heroes(zh-CN)");
console.log(`    → first hero: ${head(heroes[0], 200)}`);

// 4. Hero matchups
if (amId) {
  await call("get_hero_matchups", { hero_id: amId, language: "schinese", limit: 3 }, `4] get_hero_matchups(hero=${amId}, zh)`);
}

// 5. Pro matches + one match detail
const pro = await call("get_pro_matches", { limit: 3, language: "schinese" }, "5] get_pro_matches(zh)");
const matchId = pro[0]?.match_id;
if (matchId) {
  await call("get_match", { match_id: matchId, language: "schinese" }, `6] get_match(${matchId}, zh)`);
}

// 6. Player search + profile
const players = await call("search_players", { q: "Sumail" }, "7] search_players(Sumail)");
if (players[0]?.account_id) {
  await call("get_player", { account_id: players[0].account_id }, `8] get_player(${players[0].account_id})`);
  await call(
    "get_player_recent_matches",
    { account_id: players[0].account_id, language: "schinese" },
    "9] get_player_recent_matches(zh)",
  );
}

// 7. Health
await call("get_api_health", {}, "10] get_api_health");

await client.close();
console.log("\n✅ Smoke test passed");
process.exit(0);

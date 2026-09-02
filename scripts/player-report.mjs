/**
 * Player report example: drive opendota-mcp over stdio like any MCP client.
 * Usage: node scripts/player-report.mjs <account_id> [language]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const accountId = Number(process.argv[2] ?? 48645517);
const language = process.argv[3] ?? "schinese";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...process.env, OPENDOTA_LANGUAGE: language },
});
const client = new Client({ name: "player-report", version: "0.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

// 1. Profile
const profile = await call("get_player", { account_id: accountId });
console.log(`═══ ${profile.profile?.personaname ?? accountId} ═══`);
console.log(`rank: ${profile.rank_tier ?? "unranked"} | mmr≈${profile.computed_mmr ?? "?"} | 国家: ${profile.profile?.loccountrycode ?? "?"}`);

// 2. Recent matches
const recent = await call("get_player_recent_matches", { account_id: accountId });
const ranked = recent.filter((m) => /ranked/i.test(String(m.lobby_type)));
const pool = ranked.length >= 5 ? ranked : recent;
const wins = pool.filter((m) => m.win).length;
const avg = (f) => Math.round(pool.reduce((s, m) => s + (m[f] ?? 0), 0) / pool.length);
console.log(`\n最近 ${pool.length} 场（${ranked.length >= 5 ? "排位" : "全部"}）: ${wins}胜 ${pool.length - wins}负，胜率 ${Math.round((wins / pool.length) * 100)}%`);
console.log(`场均 KDA: ${avg("kills")}/${avg("deaths")}/${avg("assists")} | 场均 GPM ${avg("gold_per_min")} XPM ${avg("xp_per_min")} 正补 ${avg("last_hits")}`);
console.log(`平均分段: ${pool.find((m) => m.average_rank)?.average_rank ?? "?"}`);

// 3. Last 30 days hero pool (server defaults to significant=0, so Turbo games count)
const heroes = await call("get_player_heroes", { account_id: accountId, date: 30, language });
const played = heroes.filter((h) => h.games > 0).slice(0, 8);
console.log(`\n近30天英雄池（${heroes.filter((h) => h.games > 0).length} 个英雄）:`);
for (const h of played) {
  console.log(`  ${h.hero.name}(${h.hero.name_en}) ${h.games}场 ${Math.round(h.win_rate_pct)}%胜率`);
}

// 4. Recent match log
console.log(`\n最近 ${Math.min(10, pool.length)} 场:`);
for (const m of pool.slice(0, 10)) {
  console.log(`  ${m.start_time?.slice(0, 10)} ${m.win ? "胜✅" : "负❌"} ${m.hero.name} ${m.kills}/${m.deaths}/${m.assists} KDA ${m.kda ?? "?"} GPM ${m.gold_per_min} (${m.game_mode}, ${m.duration})${m.average_rank ? ` [${m.average_rank}]` : ""}`);
}

// 5. Newest match detail
const newest = pool[0];
const match = await call("get_match", { match_id: newest.match_id, language, include: { picks_bans: false } });
const me = match.players.find((p) => p.account_id === accountId);
console.log(`\n最新一场重点数据 (${match.game_mode}, ${match.duration}):`);
console.log(`  ${me.hero.name} ${me.kills}/${me.deaths}/${me.assists} | 等级${me.level} | 正补${me.last_hits}/反补${me.denies} | 净资产${me.net_worth}`);
console.log(`  出装: ${me.items.map((i) => i.name).join(", ")}`);
if (me.ability_build?.length) console.log(`  技能加点: ${me.ability_build.map((a) => a.name_en).join(" → ")}`);

await client.close();

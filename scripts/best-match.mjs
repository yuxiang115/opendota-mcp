/**
 * Find the player's best recent match and deep-dive it.
 * Usage: node scripts/best-match.mjs <account_id> [language]
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
const client = new Client({ name: "best-match", version: "0.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

// 1. Rank recent matches: wins scored by KDA weighted with participation & economy
const matches = await call("get_player_matches", { account_id: accountId, limit: 100 });
const wins = matches.filter((m) => m.win);
const score = (m) => (m.kda ?? 0) * 10 + (m.gold_per_min ?? 0) / 100 + ((m.assists ?? 0) / 100);
wins.sort((a, b) => score(b) - score(a));
console.log(`共 ${matches.length} 场（${wins.length} 胜），最佳候选:`);
for (const m of wins.slice(0, 3)) {
  console.log(`  ${m.match_id} ${m.hero.name} ${m.kills}/${m.deaths}/${m.assists} KDA ${m.kda} GPM ${m.gold_per_min} ${m.duration} [${m.average_rank ?? "?"}] score=${score(m).toFixed(1)}`);
}
const best = wins[0];

// 2. Full detail of the best match
const match = await call("get_match", {
  match_id: best.match_id,
  language,
  include: { picks_bans: true, teamfights: true, graphs: true, objectives: true, benchmarks: true },
});

console.log(`\n═══ 战局 ${match.match_id} ═══`);
console.log(`${match.radiant_team_name ?? "Radiant"} vs ${match.dire_team_name ?? "Dire"} | ${match.game_mode} | ${match.duration} | 胜方: ${match.radiant_win ? "天辉" : "夜魇"}`);
console.log(`比分 ${match.radiant_score}:${match.dire_score} | 一血 ${match.first_blood_time} | 场均分段 ${match.players.find((p) => p.average_rank)?.average_rank ?? "?"}`);

const me = match.players.find((p) => p.account_id === accountId);
console.log(`\n你的数据: ${me.hero.name}(${me.hero.name_en}) [${me.is_radiant ? "天辉" : "夜魇"}]`);
console.log(`  ${me.kills}/${me.deaths}/${me.assists} KDA ${me.kda} | Lv${me.level} | GPM ${me.gold_per_min} XPM ${me.xp_per_min} | 正补 ${me.last_hits} 反补 ${me.denies} | 净资产 ${me.net_worth}`);
console.log(`  英雄伤害 ${me.hero_damage} | 建筑伤害 ${me.tower_damage} | 治疗 ${me.hero_healing}`);
console.log(`  道具: ${[...me.items, ...me.backpack].map((i) => i.name).join(", ")}${me.neutral_item ? ` | 神器: ${me.neutral_item.name}` : ""}`);
if (me.obs_placed != null) console.log(`  插眼 ${me.obs_placed} 哨兵 ${me.sen_placed ?? 0}`);
if (me.benchmarks) {
  const bm = Object.entries(me.benchmarks).map(([k, v]) => `${k}: ${v.pct ? Math.round(v.pct * 100) : "?"}%`).join(", ");
  console.log(`  基准分位: ${bm}`);
}

// 3. Team comparison: your rank within the game
const sorted = [...match.players].sort((a, b) => (b.hero_damage ?? 0) - (a.hero_damage ?? 0));
const myDmgRank = sorted.findIndex((p) => p.account_id === accountId) + 1;
console.log(`\n英雄伤害全场第 ${myDmgRank}/10:`);
for (const p of sorted) {
  const tag = p.account_id === accountId ? " ←你" : "";
  console.log(`  ${p.is_radiant ? "天辉" : "夜魇"} ${p.personaname ?? p.account_id} ${p.hero.name} ${p.kills}/${p.deaths}/${p.assists} 伤害${p.hero_damage} GPM${p.gold_per_min}${tag}`);
}

// 4. Momentum: gold advantage curve sampled
if (match.radiant_gold_advantage_by_minute) {
  const adv = match.radiant_gold_advantage_by_minute;
  const sampleAt = [5, 10, 15, 20, 25, 30, 35, 40, 45].filter((t) => t < adv.length);
  console.log(`\n天辉经济领先曲线(采样): ${sampleAt.map((t) => `${t}'${adv[t] > 0 ? "+" : ""}${adv[t]}`).join("  ")}`);
  const peak = adv.reduce((mi, v, i, a) => (Math.abs(v) > Math.abs(a[mi]) ? i : mi), 0);
  console.log(`最大波动出现在 ${peak} 分钟 (${adv[peak] > 0 ? "天辉" : "夜魇"} 领先 ${Math.abs(adv[peak])})`);
}

// 5. Teamfights and your participation
if (match.teamfights) {
  const myIdx = match.players.findIndex((p) => p.account_id === accountId);
  console.log(`\n团战 ${match.teamfights.length} 次:`);
  match.teamfights.forEach((tf, i) => {
    const mine = myIdx >= 0 ? tf.players[myIdx] : undefined;
    console.log(`  #${i + 1} ${tf.start}-${tf.end} 击杀${tf.deaths} ${mine ? `你: 伤害${mine.damage ?? 0} 死亡${mine.deaths ?? 0} 经济${mine.gold_delta >= 0 ? "+" : ""}${mine.gold_delta ?? 0}` : ""}`);
  });
}

if (match.objectives?.length) {
  const rosh = match.objectives.filter((o) => /roshan/i.test(String(o.type)));
  if (rosh.length) console.log(`\n肉山击杀 ${rosh.length} 次: ${rosh.map((r) => `${r.time ?? r.minute ?? ""}${r.team === 2 ? "天辉" : r.team === 3 ? "夜魇" : ""}`).join(", ")}`);
}

await client.close();

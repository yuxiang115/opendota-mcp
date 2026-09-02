/**
 * Upstream request accounting: boots the server behind a counting proxy
 * (forwards to the real OpenDota API) and prints how many upstream requests
 * each scenario costs. Run: npm run count
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const counts = [];
const proxy = http.createServer(async (req, res) => {
  counts.push(req.url.split("?")[0]);
  try {
    const upstream = await fetch("https://api.opendota.com" + req.url, { signal: AbortSignal.timeout(30000) });
    const body = await upstream.text();
    res.setHeader("content-type", "application/json");
    res.statusCode = upstream.status;
    res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const port = proxy.address().port;

// The proxy listens on a random port each run, so the base URL (and therefore
// every disk-cache key) is unique — no fake api key needed for a cold start.
const env = {
  ...process.env,
  OPENDOTA_BASE_URL: `http://127.0.0.1:${port}/api`,
  OPENDOTA_RATE_LIMIT: "1000",
  OPENDOTA_BUNDLE_SEED: "1",
};

const t = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env });
const c = new Client({ name: "count", version: "0" });
await c.connect(t);
await new Promise((r) => setTimeout(r, 3000));

const call = async (name, args) => {
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${(res.content?.[0]?.text ?? "").slice(0, 120)}`);
  return JSON.parse(res.content[0].text);
};

const report = (label) => {
  const summary = counts.map((u) => u.replace("/api", ""));
  console.log(`${label.padEnd(34)} ${String(counts.length).padStart(2)} 个  ${[...new Set(summary)].join(", ") || "(缓存命中)"}`);
  counts.length = 0;
};

await new Promise((r) => setTimeout(r, 2000));
report("冷启动(探针+播种)");
await call("get_match", { match_id: 8976950353, language: "schinese", include: { picks_bans: true, teamfights: true, objectives: true, chat: true, graphs: true, breakdown: true, benchmarks: true } });
report("get_match 全量 include");
await call("get_match", { match_id: 8976950353, language: "schinese" });
report("追问同一场比赛");
await call("get_match", { match_id: 8972999235 });
report("换一场比赛");
for (const [name, args] of [
  ["get_player", { account_id: 48645517 }],
  ["get_player_recent_matches", { account_id: 48645517 }],
  ["get_player_win_loss", { account_id: 48645517 }],
  ["get_player_heroes", { account_id: 48645517 }],
]) {
  await call(name, args);
}
report("玩家四连问");

await c.close();
proxy.close();

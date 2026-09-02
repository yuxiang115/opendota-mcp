/** Summarize an opendota-mcp JSONL telemetry log. Usage: node scripts/analyze-logs.mjs <file> */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/analyze-logs.mjs <log.jsonl>");
  process.exit(1);
}
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const boots = lines.filter((l) => l.event === "boot");
const tools = lines.filter((l) => l.event === "tool_call");
const upstreams = lines.filter((l) => l.event === "upstream");

console.log("═══ 会话总览 ═══");
console.log(`boot 次数: ${boots.length}  版本: ${[...new Set(boots.map((b) => b.version))].join(",")}`);
console.log(`工具调用: ${tools.length} 次（成功 ${tools.filter((t) => t.ok).length} / 失败 ${tools.filter((t) => !t.ok).length}）`);
console.log(`上游请求: ${upstreams.length} 个（平均 ${(upstreams.reduce((s, u) => s + u.duration_ms, 0) / Math.max(1, upstreams.length)).toFixed(0)}ms）`);
const errs = upstreams.filter((u) => u.error);
if (errs.length) console.log(`上游错误: ${errs.length} 个`);

console.log("\n═══ 按工具统计 ═══");
const byTool = new Map();
for (const t of tools) {
  const e = byTool.get(t.tool) ?? { calls: 0, fails: 0, ms: 0, bytes: 0 };
  e.calls++; if (!t.ok) e.fails++; e.ms += t.duration_ms; e.bytes += t.result_bytes ?? 0;
  byTool.set(t.tool, e);
}
for (const [tool, e] of [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
  const ups = upstreams.filter((u) => u.tool === tool).length;
  console.log(`  ${tool.padEnd(28)} ${e.calls}次 失败${e.fails} 上游${ups} 均${Math.round(e.ms / e.calls)}ms 均输出${Math.round(e.bytes / e.calls / 1024)}KB`);
}

console.log("\n═══ 逐 trace 明细 ═══");
for (const t of tools) {
  const ups = upstreams.filter((u) => u.trace_id === t.trace_id);
  const paths = [...new Set(ups.map((u) => u.path))];
  console.log(`  [${t.trace_id}] ${t.tool} ${t.duration_ms}ms ${t.ok ? "✓" : "✗ " + (t.error ?? "").slice(0, 60)}`);
  if (paths.length) console.log(`      上游(${ups.length}): ${paths.join(", ")}`);
}

console.log("\n═══ 上游路径频次 ═══");
const byPath = new Map();
for (const u of upstreams) byPath.set(u.path, (byPath.get(u.path) ?? 0) + 1);
for (const [p, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x ${p}`);

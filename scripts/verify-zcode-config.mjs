/** Verify the exact command/env entries from the ZCode configs actually boot the server. */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";

// Read the real config so the test uses exactly what ZCode will use — no escaping guesswork.
const userConfig = JSON.parse(readFileSync(path.join(os.homedir(), ".zcode/cli/config.json"), "utf8"));
const server = userConfig.mcp.servers.opendota;
console.log(`user config entry: command=${server.command} args=${server.args} env=${JSON.stringify(server.env)}`);

const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  env: { ...process.env, ...server.env },
});
const client = new Client({ name: "zcode-config-check", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`✅ boot OK, ${tools.length} tools`);

const r = await client.callTool({ name: "search_dota_entities", arguments: { query: "祈求者" } });
const hit = JSON.parse(r.content[0].text).matches[0];
console.log(`✅ default-language search (祈求者 → ${hit.id} ${hit.name}/${hit.name_en})`);

const r2 = await client.callTool({ name: "get_heroes", arguments: {} });
const first = JSON.parse(r2.content[0].text)[0];
console.log(`✅ get_heroes default lang → id=${first.id} name=${first.name} (${first.name_en})`);

const r3 = await client.callTool({ name: "get_pro_matches", arguments: { limit: 1 } });
const m = JSON.parse(r3.content[0].text)[0];
console.log(`✅ pro match → ${m.radiant_name} vs ${m.dire_name}, ${m.duration}`);

await client.close();
console.log("ZCode user-config verification passed");

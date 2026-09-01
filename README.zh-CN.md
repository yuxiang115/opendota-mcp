# opendota-mcp

[English](README.md)

一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，让 LLM / Agent 通过 [OpenDota API](https://docs.opendota.com) 直接查询 **Dota 2 数据** —— 内置完整的**数据映射**（所有英雄/物品/技能 ID 解析为名称、所有枚举转为可读标签）和 **28 种语言**的游戏实体名称本地化。

Agent 可以直接回答 *"敌法师克制哪些英雄？"*、*"SumaiL 最近 5 场排位玩了什么？"*、*"分析昨天 Team Spirit 那场比赛的 BP"* 这类问题，全程不接触原始数字 ID。

## 特性

- **42 个工具**覆盖 OpenDota 公开 API 全部端点：比赛、玩家、英雄、战队、职业赛事、联赛、直播对局、常量、搜索、录像解析提交。
- **面向 LLM 的数据映射**：
  - `hero_id: 53` → `hero: { id: 53, name: "自然先知", name_en: "Nature's Prophet" }`
  - `game_mode: 22` → `"All Draft"`、`lobby_type: 7` → `"Ranked"`、`rank_tier: 55` → `"Legend 5"`
  - 时长 → `"37:22"`、时间戳 → ISO、自动计算 KDA / 胜负 / 阵营 / 胜率
- **28 种语言**的英雄/物品/技能名称（简中、繁中、英语、俄语、西语、葡语、法语、德语、日语、韩语、泰语、越南语、土耳其语等），数据来自 Valve 官方本地化源。支持按工具传 `language` 参数或环境变量全局设置。
- **Agent 友好入口**：`search_dota_entities` 把任意本地化名或英文名（"敌法师"、"blink dagger"、"祈求者"）解析成其他工具需要的 ID；`search_players` 按玩家名查 account id。
- **礼貌的 API 客户端**：令牌桶限流（遵守免费 60 次/分钟）、响应缓存、429 处理、可选 `OPENDOTA_API_KEY`。

## 快速开始

要求：Node.js ≥ 18。

```bash
git clone https://github.com/yuxiang115/opendota-mcp.git
cd opendota-mcp
npm install
npm run build
node dist/index.js   # 以 stdio 模式启动 MCP server
```

或直接 npx 运行：

```bash
npx opendota-mcp
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENDOTA_API_KEY` | *(无)* | 你的 [OpenDota API key](https://www.opendota.com/api-keys)，限流从 60/分钟 提升到 3000/分钟。 |
| `OPENDOTA_LANGUAGE` | `english` | 英雄/物品/技能名称的默认语言。支持 Steam 码（`schinese`）或标签（`zh-CN`）。 |
| `OPENDOTA_BASE_URL` | `https://api.opendota.com/api` | 自建 OpenDota 实例地址。 |
| `OPENDOTA_RATE_LIMIT` | 无 key 时 `55` | 客户端每分钟最大请求数。 |

### Claude Code

```bash
claude mcp add opendota -- npx opendota-mcp
```

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "opendota": {
      "command": "npx",
      "args": ["opendota-mcp"],
      "env": {
        "OPENDOTA_LANGUAGE": "schinese"
      }
    }
  }
}
```

### Cursor / 其他 MCP 客户端

```json
{
  "mcpServers": {
    "opendota": {
      "command": "npx",
      "args": ["opendota-mcp"]
    }
  }
}
```

## 工具总览（42 个）

- **查询入口**：`search_dota_entities`（名称→ID，先调这个）、`search_players`（玩家名→account id）、`list_supported_languages`、`get_api_health`、`get_constants`
- **比赛**：`get_match`（紧凑增强视图，英雄/物品/技能全部带名称，可选 picks_bans/teamfights/chat/经济曲线等）、`request_match_parse`、`get_parse_job_status`
- **玩家**（15 个）：档案+段位、最近比赛、筛选战绩、胜率统计、英雄池、常一起玩的玩家、生涯总计、分布直方图、眼位图、词云、段位历史、英雄排名、刷新历史 等
- **英雄**（9 个）：英雄列表、全分段选取/胜率、克制关系（matchups）、基准分、物品热度、时长胜率曲线、英雄玩家榜 等
- **战队/职业/直播**（8 个）：战队列表与档案、战队比赛/成员/英雄池、职业比赛、职业选手、联赛、直播对局

完整说明见 [README.md](README.md) 的工具表格，或启动后用 MCP 客户端的工具列表查看。

## 本地化数据

`locales/` 目录内置 28 种语言名称表（英雄 127 / 物品 544 / 技能 2702 条），由 `npm run build:locales` 从 Valve 官方 datafeed 重新生成。任何返回游戏实体的工具都接受 `language` 参数（`"schinese"`、`"zh-CN"`、`"ru"` 等），名称字段统一为 `{ name: 本地化名, name_en: 英文名 }`。

## 开发

```bash
npm install
npm run build           # 编译 src/ → dist/
npm run build:locales   # 重新抓取 Valve 本地化数据 → locales/
npm run smoke           # stdio 端到端真实调用测试
npm run check           # 仅类型检查
```

## 致谢与许可

- 数据来源：[OpenDota API](https://www.opendota.com)
- 本地化名称：Valve 官方 Dota 2 数据源
- Dota 2 是 Valve Corporation 的商标，本项目与 Valve、OpenDota 无隶属关系
- 代码许可：[MIT](LICENSE)

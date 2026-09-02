# opendota-mcp

[English](README.md)

一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，让 LLM / Agent 通过 [OpenDota API](https://docs.opendota.com) 直接查询 **Dota 2 数据** —— 内置完整的**数据映射**（所有英雄/物品/技能 ID 解析为名称、所有枚举转为可读标签）和 **28 种语言**的游戏实体名称本地化。

Agent 可以直接回答 *"敌法师克制哪些英雄？"*、*"SumaiL 最近 5 场排位玩了什么？"*、*"分析昨天 Team Spirit 那场比赛的 BP"* 这类问题，全程不接触原始数字 ID。

## 特性

- **52 个工具**覆盖 OpenDota 公开 API 全部端点（配 STRATZ token 后 62 个）：比赛、玩家、英雄、战队、职业赛事、联赛、直播对局、场景统计、SQL 数据浏览器、常量、搜索、录像解析提交。
- **面向 LLM 的数据映射**：
  - `hero_id: 53` → `hero: { id: 53, name: "自然先知", name_en: "Nature's Prophet" }`
  - `game_mode: 22` → `"All Draft"`、`lobby_type: 7` → `"Ranked"`、`rank_tier: 55` → `"Legend 5"`
  - 时长 → `"37:22"`、时间戳 → ISO、自动计算 KDA / 胜负 / 阵营 / 胜率
- **统计诚实**：所有胜率带 95% 置信区间（`win_rate_ci95_pp`），小样本自动标 `low_sample` —— 让 agent 说"克制，62% ± 4"而不是把噪声当结论
- **28 种语言**的英雄/物品/技能名称（简中、繁中、英语、俄语、西语、葡语、法语、德语、日语、韩语、泰语、越南语、土耳其语等），数据来自 Valve 官方本地化源。支持按工具传 `language` 参数或环境变量全局设置。
- **Agent 友好入口**：`search_dota_entities` 把任意本地化名或英文名（"敌法师"、"blink dagger"、"祈求者"）解析成其他工具需要的 ID；`search_players` 按玩家名查 account id。
- **可选 STRATZ 增强**（`STRATZ_API_TOKEN`，免费）：10 个分段/位置维度的聚合工具，全量级样本 —— 分段克制、出装时间线、天赋/加点统计、对线胜负、位置表现、版本趋势、反制推荐与阵容画像（含教练级建议）
- **赛后复盘主线**：`get_match_coaching` 输入 match_id 一键出教练报告（每人 vs 分段基准、时间窗判决、败因笔记）
- **内置引导**：4 个注册 MCP prompt（比赛复盘/玩家体检/英雄攻略/环境报告）+ 可装载的 [Agent Skill](skill/SKILL.md) 完整分析打法
- **礼貌的 API 客户端**：令牌桶限流（遵守免费 60 次/分钟）、响应缓存（磁盘持久化）、429 处理、可选 `OPENDOTA_API_KEY`。

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
| `STRATZ_API_TOKEN` | *(无)* | **启用 STRATZ 工具组**。在 [stratz.com/api](https://stratz.com/api) 用 Steam 登录免费领取，新增 10 个分段/位置维度聚合工具（见下）。 |
| `STRATZ_BASE_URL` | `https://api.stratz.com/graphql` | 测试用覆盖。 |

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

> **Windows 提示**：Claude Desktop（及部分客户端）在 Windows 下不能直接 spawn `npx`，需要 `cmd /c` 包装：
>
> ```json
> { "command": "cmd", "args": ["/c", "npx", "-y", "opendota-mcp"] }
> ```
>
> 该模式已被 `npm run integration` 集成测试覆盖。

### 安装 Agent Skill（推荐）

包内附带 [Agent Skill](skill/SKILL.md)，把完整的 Dota 分析打法（工具调用顺序、字段解读、分段数据边界）教给宿主 agent。Skill 由**宿主程序**加载（不是 MCP 服务器），装好服务器后运行：

```bash
npx opendota-mcp install-skill          # 自动探测已装的宿主
npx opendota-mcp install-skill all      # 全部宿主
npx opendota-mcp install-skill zcode    # 指定: claude-code | zcode | openclaw
```

| 宿主 | Skill 位置 |
|---|---|
| Claude Code | `~/.claude/skills/opendota/SKILL.md` |
| ZCode | `~/.agents/skills/opendota/SKILL.md` |
| openclaw | `openclaw skills install <repo>/skill` |

装完重启宿主（或开新会话）生效；不装也能用，只是 agent 要自己摸索工具路径。

## 工具总览（52 个，配 STRATZ token 共 62 个）

- **查询入口**：`search_dota_entities`（名称→ID，先调这个）、`search_players`（玩家名→account id）、`list_supported_languages`、`get_api_health`、`get_constants`
- **比赛**：`get_match`（紧凑增强视图，英雄/物品/技能全部带名称，可选 picks_bans/teamfights/chat/经济曲线等）、`request_match_parse`、`get_parse_job_status`
- **玩家**（15 个）：档案+段位、最近比赛、筛选战绩、胜率统计、英雄池、常一起玩的玩家、生涯总计、分布直方图、眼位图、词云、段位历史、英雄排名、刷新历史 等。**默认口径**：本服务端对筛选工具默认传 `significant=0`（包含 Turbo 等全部模式，OpenDota 官方默认会静默滤掉 Turbo）；只要标准模式请显式传 `significant=1`
- **英雄**：英雄列表、技能/天赋/facets 权威参考（`get_hero_kit`，接受任意语言名）、物品参考（`get_item_details`）、全分段选取/胜率、克制关系（matchups）、基准分、物品热度、时长胜率曲线、英雄玩家榜 等
- **场景统计与 SQL 浏览器**：出装时间线胜率、分路×时长胜率、公开比赛实时流、加点顺序胜率、队友协同胜率、**针对特定对面英雄的出装胜率交叉表**（`get_item_winrate_vs_hero`）、数据集表结构、自由 SQL 查询
- **STRATZ 增强（需 token，9 个）**：分段克制 `get_matchups_by_rank`、分段出装+购买时间 `get_item_builds_by_rank`、天赋胜率 `get_talent_stats`、加点统计 `get_skill_builds_by_rank`、对线胜负 `get_lane_matchups`、位置表现 `get_hero_position_stats`、反制推荐 `get_draft_advice`、**阵容画像+教练建议 `get_draft_composition`**、**一键赛后复盘 `get_match_coaching`**、版本走势 `get_hero_trend`
- **战队/职业/直播**（8 个）：战队列表与档案、战队比赛/成员/英雄池、职业比赛、职业选手、联赛、直播对局

完整说明见 [README.md](README.md) 的工具表格，或启动后用 MCP 客户端的工具列表查看。

## 本地化数据

`locales/` 目录内置 28 种语言名称表（英雄 127 / 物品 544 / 技能 2702 条），由 `npm run build:locales` 从 Valve 官方 datafeed 重新生成。任何返回游戏实体的工具都接受 `language` 参数（`"schinese"`、`"zh-CN"`、`"ru"` 等），名称字段统一为 `{ name: 本地化名, name_en: 英文名 }`。

## 开发

```bash
npm install
npm run build           # 编译 src/ → dist/
npm run build:locales   # 重新抓取 Valve 本地化数据 → locales/
npm run build:data      # 重建常量 bundle（constants-bundle/）
npm run integration     # stdio 端到端测试（含 mock 上游回归）
npm run smoke           # 真实 API 快速冒烟
npm run check           # 仅类型检查
```

## 致谢与许可

- 数据来源：[OpenDota API](https://www.opendota.com)；分段聚合（可选）：[STRATZ API](https://stratz.com/api)
- 本地化名称：Valve 官方 Dota 2 数据源
- Dota 2 是 Valve Corporation 的商标，本项目与 Valve、OpenDota、STRATZ 无隶属关系
- 代码许可：[MIT](LICENSE)

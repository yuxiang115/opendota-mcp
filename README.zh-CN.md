# opendota-mcp

[English](README.md)

一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，让 LLM / Agent 通过 [OpenDota API](https://docs.opendota.com) 直接查询 **Dota 2 数据** —— 内置完整的**数据映射**（所有英雄/物品/技能 ID 解析为名称、所有枚举转为可读标签）和 **28 种语言**的游戏实体名称本地化。

Agent 可以直接回答 *"敌法师克制哪些英雄？"*、*"SumaiL 最近 5 场排位玩了什么？"*、*"分析昨天 Team Spirit 那场比赛的 BP"* 这类问题，全程不接触原始数字 ID。

## 特性

- **54 个工具**覆盖 OpenDota 公开 API 全部端点（配 STRATZ token 后 64 个）：比赛、玩家、英雄、战队、职业赛事、联赛、直播对局、场景统计、SQL 数据浏览器、常量、搜索、录像解析提交。
- **面向 LLM 的数据映射**——响应开箱即读：
  - `hero_id: 53` → `hero: { id: 53, name: "自然先知", name_en: "Nature's Prophet" }`
  - `game_mode: 22` → `"All Draft"`、`lobby_type: 7` → `"Ranked"`、`rank_tier: 55` → `"Legend 5"`
  - 时长 → `"37:22"`、时间戳 → ISO、自动计算 KDA / 胜负 / 阵营 / 胜率
- **统计诚实**：所有胜率带 95% 置信区间（`win_rate_ci95_pp`），小样本自动标 `low_sample` —— 让 agent 说"克制，62% ± 4"而不是把噪声当结论。
- **28 种语言**的英雄/物品/技能名称（简中、繁中、英语、俄语、西语、葡语、法语、德语、日语、韩语、泰语、越南语、土耳其语等），数据来自 Valve 官方本地化源。支持按工具传 `language` 参数或环境变量全局设置。
- **社区黑话昵称**：火猫、大骨灰、白牛、跳刀、BKB……内置 180+ 条昵称映射，所有接受名称的地方都能用；歧义昵称（猴子/ES）返回候选列表让 agent 问用户，绝不瞎猜（详见下文）。
- **Agent 友好入口**：`search_dota_entities` 把任意本地化名或英文名（"敌法师"、"blink dagger"、"祈求者"）解析成其他工具需要的 ID；`search_players` 按玩家名查 account id。
- **可选 STRATZ 增强**（`STRATZ_API_TOKEN`，免费）：10 个分段/位置维度的聚合工具，全量级样本 —— 分段克制、出装时间线、天赋/加点统计、对线胜负、位置表现、版本趋势、反制推荐与阵容画像（含教练级建议）。
- **内置引导**：4 个注册 MCP prompt（比赛复盘 / 玩家体检 / 英雄攻略 / 环境报告）+ 可装载的 [Agent Skill](skill/SKILL.md) 完整分析打法。
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
# 或在仓库目录内
npx .
```

### 安装 Agent Skill（推荐）

包内附带 [Agent Skill](skill/SKILL.md)（`skill/SKILL.md`），把完整的 Dota 分析打法（该调哪些工具、怎么读增强字段、分段数据边界）教给宿主 agent。Skill 由**宿主程序**加载（不是 MCP 服务器），装好服务器后运行：

```bash
npx opendota-mcp install-skill          # 自动探测已装的宿主
npx opendota-mcp install-skill all      # 全部宿主
npx opendota-mcp install-skill zcode    # 指定: claude-code | zcode | openclaw
npx opendota-mcp install-skill openclaw --force   # 覆盖已装的 skill（升级用）
```

也可以手动安装：

| 宿主 | Skill 位置 |
|---|---|
| Claude Code | `~/.claude/skills/opendota/SKILL.md` |
| ZCode | `~/.agents/skills/opendota/SKILL.md` |
| openclaw | `openclaw skills install <repo>/skill` |
| 还没装任何宿主 | `curl -fsSL https://raw.githubusercontent.com/yuxiang115/opendota-mcp/main/skill/SKILL.md -o SKILL.md` |

装完重启宿主（或开新会话）生效；不装也能用，只是 agent 要自己摸索工具路径。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENDOTA_API_KEY` | *(无)* | 你的 [OpenDota API key](https://www.opendota.com/api-keys)，限流从 60/分钟 提升到 3000/分钟。 |
| `OPENDOTA_LANGUAGE` | `english` | 英雄/物品/技能名称的默认语言。支持 Steam 码（`schinese`）或标签（`zh-CN`）。 |
| `OPENDOTA_BASE_URL` | `https://api.opendota.com/api` | 自建 OpenDota 实例地址。 |
| `OPENDOTA_RATE_LIMIT` | 无 key 时 `55`（有 key 时 `1200`） | 客户端每分钟最大请求数。 |
| `STRATZ_API_TOKEN` | *(无)* | **启用 STRATZ 工具组**。在 [stratz.com/api](https://stratz.com/api) 用 Steam 登录免费领取，新增 10 个分段/位置维度聚合工具（见下）。 |
| `STRATZ_BASE_URL` | `https://api.stratz.com/graphql` | 测试用覆盖。 |
| `OPENDOTA_ALIASES_FILE` | 存在时读 `~/.config/opendota-mcp/aliases.json` | 用户自定义黑话昵称映射（见下）。 |

### 黑话昵称

中国玩家很少用官方名称——火猫（灰烬之灵）、大骨灰（魂之灵瓮）、白牛（裂魂人）、跳刀（闪烁匕首）才是日常叫法。服务器内置 180+ 条精选昵称映射，所有接受名称的地方都生效：`search_dota_entities`、hero 参数、item 参数。**歧义昵称故意不解析**（猴子 = 幻影长矛手还是齐天大圣？ES = 四个猫？）——工具会返回候选列表让 agent 问用户，绝不瞎猜。

缺哪个外号？写一个 JSON 到 `~/.config/opendota-mcp/aliases.json`（或用 `OPENDOTA_ALIASES_FILE` 指定路径）：

```json
{ "heroes": { "我的外号": "ember_spirit" }, "items": { "我的道具": "blink" } }
```

目标写 npc 内名；无效目标会被静默忽略，用户条目优先于内置表。欢迎 PR 补充 `src/aliases.ts`。

### STRATZ 分段统计（可选）

OpenDota 的公开场景端点已不支持按天梯分段过滤，英雄对英雄聚合也只有很小的 parsed 样本（每对位约 100 场）。配置 `STRATZ_API_TOKEN` 后会额外注册 10 个工具，由 [STRATZ](https://stratz.com) 的 GraphQL API 支撑，全量级样本（数万场）且支持分段/位置过滤：

| 工具 | 回答什么 |
|---|---|
| `get_matchups_by_rank` | 某英雄**在指定分段**克制谁 / 被谁克制（带 95% 置信区间）。传 `vs_hero` 直接查指定对位，中游对位也能返回。 |
| `get_item_builds_by_rank` | 某英雄在某分段/位置买什么装备、平均购买分钟数、购买局胜率。 |
| `get_talent_stats` | 哪个天赋选择真的能赢，按分段/位置。 |
| `get_skill_builds_by_rank` | 分段/位置加点：每个技能几级首点、几级点满，占比+胜率。 |
| `get_hero_position_stats` | 每个位置的对局数、胜率和完整对局画像（K/D/A、伤害、塔伤）——这英雄是 1 号位还是 4 号位？ |
| `get_draft_composition` | **教练级阵容分析**：双方伤害构成、控制集中度、续航差距、前中后期强势窗口 + 数据支撑的教练笔记。 |
| `get_match_coaching` | **一键赛后复盘**：输入 match_id —— 自动按玩家奖牌识别分段、双方阵容画像、每人 vs 分段基准、时间窗判决、教练笔记。 |
| `get_lane_matchups` | 对线期胜负（胜/负/均）对每个对面英雄。 |
| `get_draft_advice` | 给定敌方阵容（+己方队友），按克制胜率和队友协同给选人推荐。 |
| `get_hero_trend` | 按版本的胜率走势（支持全部 8 个细分分段）——削弱后这英雄还能玩吗？ |

分段参数映射 STRATZ 的档位（`herald_guardian` … `divine_immortal`）；趋势工具支持全部 8 档细分。所有胜率由原始计数重新计算，每行带 `win_rate_ci95_pp` / `low_sample`，让 agent 诚实引用数字。STRATZ 请求带缓存（30 分钟）和限流。

### HTTP 部署（Docker）

需要常驻共享服务器（远程 MCP 客户端接入，替代每台机器本地 stdio）时：

1. clone 后直接在 `docker-compose.yml` 里改 token（无需 env 文件）：

```bash
git clone https://github.com/yuxiang115/opendota-mcp.git && cd opendota-mcp
vim docker-compose.yml        # 把 OPENDOTA_HTTP_TOKEN 改成你自己的密钥
docker compose up -d --build  # 在 127.0.0.1:8787/mcp 提供 MCP Streamable HTTP
```

2. 前置 nginx（或任意 TLS 代理）做 HTTPS —— 对 SSE 流关闭缓冲、调大读超时。
   `/healthz` 是无鉴权存活探针。不用 compose 直接跑镜像时设置
   `OPENDOTA_TRANSPORT=http` 和 `PORT`。磁盘缓存持久化在 `opendota-cache` 卷里。

#### 对接 MCP 客户端

每个客户端只需要两样东西：**URL**（`https://你的域名/mcp`）和你在 compose 里设
的 **token**，以请求头发送：`Authorization: Bearer <你的 token>`。

Claude Code：

```bash
claude mcp add --transport http opendota https://你的域名/mcp \
  --header "Authorization: Bearer <你的 token>"
```

Cursor / Claude Desktop / 任何支持 JSON 配置的 MCP 客户端：

```json
{
  "mcpServers": {
    "opendota": {
      "type": "http",
      "url": "https://你的域名/mcp",
      "headers": { "Authorization": "Bearer <你的 token>" }
    }
  }
}
```

用 curl 冒烟测试（响应头里应出现 `mcp-session-id`；不带 token 会得到 401）：

```bash
curl -i https://你的域名/mcp \
  -H "Authorization: Bearer <你的 token>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

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

## 工具

### 查询与系统

| 工具 | 说明 |
|---|---|
| `search_dota_entities` | 把英雄/物品/技能**名称**（英文或任意支持语言，含黑话昵称）解析成数字 ID。从这里开始。 |
| `search_players` | 按玩家显示名查 account id。 |
| `list_supported_languages` | 全部支持的本地化语言。 |
| `get_api_health` | OpenDota 服务健康状态。 |
| `get_constants` | 原始 OpenDota 常量资源（heroes、items、item_ids、abilities、ability_ids、game_mode、lobby_type、region、patch 等）。 |

### 比赛

| 工具 | 说明 |
|---|---|
| `get_match` | 完整比赛详情，紧凑增强视图（英雄/物品/技能带名称、每人 KDA/GPM/XPM，`include` 可选 picks_bans/teamfights/objectives/chat/经济曲线/日志）。 |
| `request_match_parse` | 提交录像解析并轮询到完成（默认等 45 秒；之后 `get_match` 即有深度数据）。 |
| `get_parse_job_status` | 查询解析任务状态。 |

### 玩家

所有玩家对局工具都接受 OpenDota 标准筛选（`hero_id`、`game_mode`、`patch`、`date`、`win`、`lane_role`、`with_hero_id`、`against_hero_id`、`limit/offset` 等）。一个刻意的默认值改动：本服务端默认传 `significant=0`（**包含 Turbo 在内的全部模式**，OpenDota 官方默认会静默滤掉 Turbo）——只要标准模式请显式传 `significant=1`。

| 工具 | 说明 |
|---|---|
| `get_player` | 档案 + 天梯奖牌（"冠绝一世"、"传奇 3"）+ MMR 估算。 |
| `get_player_recent_matches` | 最近约 20 场，增强视图。 |
| `get_player_matches` | 筛选战绩。 |
| `get_player_win_loss` | 胜负场次 + 胜率。 |
| `get_player_heroes` | 玩最多的英雄及胜率。 |
| `get_player_peers` | 开黑队友：一起的场次、同队胜率、开黑时平均 GPM/XPM —— "我们车队水平如何"视图。 |
| `get_player_opponents` | **经常被匹配到对面的人**：扫描近期对局（含 Turbo）→ 常见对手、他们的段位、最喜欢对你用的英雄、你对他们的胜率。 |
| `get_player_partnership` | **和某一个好友的双排深挖**：同队 vs 对位的场次和胜率、两人共同对局里各自最常玩的英雄（开黑时谁玩什么）、最近一次同场。 |
| `get_player_pros` | 遇到过的职业选手。 |
| `get_player_totals` | 生涯总计（击杀、经济、伤害……）。 |
| `get_player_counts` | 按模式/大厅/分路/地区/版本的对局分布（ID 已解析）。 |
| `get_player_histogram` | 单项数据分布直方图。 |
| `get_player_wardmap` | 插眼位置热力图。 |
| `get_player_wordcloud` | 聊天词云。 |
| `get_player_rating_history` | 天梯奖牌历史。 |
| `get_player_hero_rankings` | 英雄排行榜百分位。 |
| `refresh_player` | 请求 OpenDota 刷新玩家历史。 |

### 英雄

| 工具 | 说明 |
|---|---|
| `get_heroes` | 全部英雄：本地化名称、属性、定位、基础数值。 |
| `get_hero_kit` | **单个英雄的完整技能参考**（接受 ID 或任意语言名称）：每个技能的描述、耗蓝、冷却、各等级数值、A 杖/魔晶标记，加全部 10 个天赋和未废弃 facets —— 再也不用猜新英雄技能。 |
| `get_item_details` | **最多 10 件物品的参考**（ID/名称，任意语言）：价格、主动/被动效果、属性加成、冷却/耗蓝、配件。 |
| `get_hero_stats` | 按分段的选取/禁用/胜率（先锋→冠绝一世、职业、Turbo）。 |
| `get_hero_matchups` | 对所有其他英雄的克制关系（胜率）。 |
| `get_hero_recent_matches` | 该英雄最近的公开对局。 |
| `get_hero_benchmarks` | 按天梯分段的百分位基准。 |
| `get_hero_item_popularity` | 按游戏阶段的物品热度，带名称。 |
| `get_hero_duration_performance` | 按时长的胜率曲线。 |
| `get_hero_players` | 该英雄的顶尖玩家。 |
| `get_hero_rankings` | 全球英雄排行榜。 |

### 场景统计与 SQL 浏览器

基于 OpenDota 场景/explorer 数据集的公开对局聚合统计（仅 parsed 对局；上游无分段过滤 —— 分段切分用上面的 STRATZ 工具）。

| 工具 | 说明 |
|---|---|
| `get_item_timing_stats` | 按购买时间的物品胜率（"PA 15 分钟前出狂战：58%"）。 |
| `get_lane_role_stats` | 分路角色 × 时长的胜率。 |
| `get_public_matches` | 按段位过滤的近期公开对局实时流，英雄已解析。 |
| `get_skill_builds` | 最常见的加点顺序及各级胜率（SQL 聚合）。 |
| `get_hero_synergy` | 按同队胜率排的最好/最差队友组合。 |
| `get_item_winrate_vs_hero` | **针对某个特定对面英雄的出装胜率** —— 出/不出对照组（"火猫打瘟疫法师出魂之灵瓮：52.8% vs 46.2%"）。 |
| `get_explorer_schema` | 公开 SQL 数据集的表/列字典。 |
| `run_explorer_query` | 对数据集跑你自己的只读 SQL。 |

### 战队、职业赛事与直播

| 工具 | 说明 |
|---|---|
| `get_teams` / `get_team` | 按积分的职业战队 / 单个战队档案。 |
| `get_team_matches` / `get_team_players` / `get_team_heroes` | 战队比赛历史、阵容、英雄池。 |
| `get_pro_matches` | 最新职业比赛。 |
| `get_pro_players` | 注册职业选手。 |
| `get_leagues` / `get_league_matches` | 联赛及其比赛。 |
| `get_live_matches` | 热门直播对局，含英雄和段位。 |

## Prompts

服务器注册了 4 个现成的工作流 prompt（MCP 客户端的斜杠菜单 / prompt 选择器里可见），固化了经过验证的分析打法：

| Prompt | 用途 |
|---|---|
| `match-analysis` | 完整赛后拆解：时间线、分路、BP、带数据证据的败因分析。 |
| `player-review` | 近期状态：胜率、英雄池、段位走势、改进建议。 |
| `hero-guide` | 单英雄的当前版本完整攻略（技能 → 分段数据 → 克制 → 出装 → 节奏）。 |
| `meta-report` | 按分段的版本环境报告，含职业赛场信号。 |

## 本地化数据

英雄/物品/技能名称本地化到 **28 种语言**（`locales/` 内置英雄 127 / 物品 544 / 技能 2702 条），由 `npm run build:locales` 从 Valve 官方本地化数据源重新生成：

english、schinese（简体中文）、tchinese（繁體中文）、japanese、koreana、russian、spanish、latam、brazilian、portuguese、french、german、italian、turkish、polish、czech、danish、dutch、finnish、greek、hungarian、norwegian、romanian、swedish、thai、vietnamese、ukrainian、bulgarian。

任何返回游戏实体的工具都接受 `language` 参数（`"schinese"`、`"zh-CN"`、`"ru"` 等），或用 `OPENDOTA_LANGUAGE` 全局设置。名称字段统一为 `{ name: 本地化名, name_en: 英文名 }`，agent 可以双语言交叉引用攻略。天梯奖牌名同样本地化，使用 Valve 官方客户端词条（`DOTARankTierName`：万古流芳 = Ancient、冠绝一世 = Immortal……），简中/繁中生效，其他语言回退英文奖牌名。

## 示例：增强比赛视图

`get_match(match_id=8978292022, language="schinese")` 返回（节选）：

```json
{
  "radiant_win": true,
  "duration": "37:22",
  "game_mode": "Captains Mode",
  "league": "EPL Masters 2026",
  "players": [
    {
      "is_radiant": true, "win": true,
      "personaname": "pray",
      "hero": { "id": 53, "name": "自然先知", "name_en": "Nature's Prophet" },
      "kills": 6, "deaths": 2, "assists": 21, "kda": 13.5,
      "gold_per_min": 901, "xp_per_min": 1062, "last_hits": 649,
      "items": [{ "slot": 0, "id": 116, "name": "闪烁匕首", "name_en": "Blink Dagger" }]
    }
  ]
}
```

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

每个上游端点都在 HTTP 层缓存（跨工具共享、磁盘持久化），按数据实际变化速度分层：

| 层级 | TTL | 覆盖 |
|---|---|---|
| parsed 比赛 | 7 天（+磁盘） | 录像分析结果不可变 —— 重复复盘和 30 场社交扫描 0 请求 |
| 未解析比赛 | 10 分钟 | 直到解析落地；解析后条目自动升级 |
| 聚合统计 | 6 小时 | heroStats、matchups、benchmarks、场景表、explorer SQL |
| 玩家档案 | 1 小时 | peers、英雄池、ratings、totals、战队 |
| 实时/最近 | 60 秒 | 最近对局、直播流、搜索 |
| 常量 | 1 小时 SWR（+bundle） | heroes/items/abilities |

STRATZ 查询缓存 4 小时（版本表 24 小时）。游戏常量随包分发（`constants-bundle/`，由 `npm run build:data` 重建、CI 每日刷新）。启动时服务器只发一个版本探针请求与 bundle 比对：一致则零额外请求直接用种子常量；版本更新（新英雄/新物品必然伴随）则立即后台刷新。之后常量经 stale-while-revalidate 每小时刷新。典型上游开销：**冷启动 + 一次完整增强比赛分析 = 2 个请求**；同一场比赛追问 = 0。`constants-bundle` 未命中则直接回退到 API 全量拉取。

**bundle 会自我更新**：每个常量资源的成功网络请求都会写回 `constants-bundle/`（尽力而为 —— npx 缓存这类只读安装会静默保留发布时的副本），manifest 的 `max_patch_id` 随之前进。所以跑得越久种子越新鲜，用户无需手动更新。`OPENDOTA_BUNDLE_PERSIST=0` 关闭写回。

项目结构：

```
src/
├── index.ts        # stdio MCP 服务器入口、工具注册
├── config.ts       # 环境变量处理
├── client.ts       # OpenDota HTTP 客户端：限流、缓存、错误处理
├── constants.ts    # OpenDota 常量加载 + 枚举标签
├── aliases.ts      # 社区黑话昵称表 + 用户扩展
├── locales.ts      # 28 语言名称表 + 语言归一化
├── mapping.ts      # id→名称解析、枚举→标签、行增强
├── enrich.ts       # 比赛/heroStats/itemPopularity 转换器
└── tools/          # 按领域划分的工具定义
locales/            # 生成的名称表（每语言一个目录）
scripts/            # build-locales、冒烟测试
```

## 致谢

- 数据来源：[OpenDota API](https://www.opendota.com) —— 开放 Dota 2 数据平台。
- 分段聚合（可选）：[STRATZ API](https://stratz.com/api) —— 免费 GraphQL Dota 2 统计。
- 本地化名称：Valve 官方 Dota 2 数据源。
- Dota 2 是 Valve Corporation 的商标。本项目与 Valve、OpenDota、STRATZ 无隶属关系。

## 许可

[MIT](LICENSE)

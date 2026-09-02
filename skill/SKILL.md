---
name: opendota
description: Analyze Dota 2 matches, players, heroes, and the current meta through the opendota MCP server. Use when the user asks about a Dota match result, why they lost, hero builds/counters/talents, player stats or rank, pro matches, or live games. Covers replay-parse workflow, blame analysis method, and hero guides with current-patch data.
---

# Dota 2 分析技能（opendota MCP）

通过 opendota MCP 获取**当前版本权威数据**。核心原则：**禁止凭模型记忆描述英雄/物品/技能/数值**——版本迭代快于训练数据，一律先查工具。

## 入口规则

1. 任何名字 → id：`search_dota_entities`（英雄/物品/技能，支持中英文如"敌法师"）、`search_players`（玩家）
2. 玩家给的是 Steam 链接？`/players/<id>` 里的数字就是 account_id；Steam64 减 76561197960265728
3. **search 失败时不要猜 account_id**——向用户要资料链接（工具会返回 hint）

## 常用工作流

### 比赛复盘（"为什么输"）
```
get_match(match_id, include={picks_bans, graphs})
├─ parsed=false → request_match_parse(match_id) → 重取 include={teamfights, objectives}
├─ 叙事: losing_team_max_gold_lead/deficit + radiant_gold_advantage_by_minute → 转折分钟
├─ 分路: 每人 lane_result + position + lane_efficiency_pct
├─ 定责: 同 position 对位比 GPM/参团率/伤害；position_basis≠position_est 时注明推测
└─ 出装审查: 对面有闪避→问为什么没 MKB（get_item_details 查物品效果）
```

### 玩家体检
`get_player` → `get_player_recent_matches` → `get_player_win_loss(date=30)` → `get_player_heroes(date=30)`（注意默认含 Turbo，只要排位传 significant=1）

### 英雄攻略
`get_hero_kit`（技能数值/天赋/facets，按 id 或中文名）→ `get_hero_stats`（分段胜率）→ `get_hero_matchups`（克制）→ `get_hero_item_popularity` + `get_item_details`（出装与装备作用）

### 版本环境
`get_hero_stats`（分段胜率+pro ban/pick）→ `get_pro_matches` → `get_live_matches`

## 分段（rank bracket）数据边界

**有分段的**：`get_hero_stats`（Herald→Immortal 8 档 + pro + turbo 胜率）、`get_hero_benchmarks`（bracket 1-8）、`get_public_matches`（min/max_rank）。
**无分段的**（数据源限制，工具描述已注明）：matchups / itemPopularity / itemTimings / laneRoleStats / skill_builds / synergy / durations 都是**全分段混合**——不要对用户声称"某分段的克制/出装数据"，只能说"全分段总体"；分段差异只能引用 get_hero_stats 的分段胜率。

**STRATZ 工具（配置 STRATZ_API_TOKEN 后可用，优先用）**：`get_matchups_by_rank`（分段克制）、`get_item_builds_by_rank`（分段出装+购买时间+胜率）、`get_talent_stats`（分段天赋胜率）、`get_lane_matchups`（对线期胜负）、`get_draft_advice`（针对敌方阵容的克制推荐+队友配合）、`get_hero_trend`（按版本的 8 档分段走势）。样本量比 OpenDota scenario 大几个数量级；回答分段相关的克制/出装/加点/对线/阵容问题一律优先用这组。bracket 参数取值 `herald_guardian`/`crusader_archon`/`legend_ancient`/`divine_immortal`（趋势工具支持 8 档细分的英文 medal 名）。

## 数据解读要点

- `position_basis`: `position_est`（官方）> `official_algorithm` > `lane_farm_heuristic` > `farm_order_only`（仅经济序猜测，低置信）
- `lane_result` 是官方 Story 口径（各路 gold@10 最大值比较，≤500 平局）
- 未解析比赛：只有基础数据（KDA/物品/bitmask），teamfights/眼位/金币来源需 parse
- `significant` 默认 0（含 Turbo）；统计排位口径时传 1
- 名称字段双轨：`name`（当前语言）/`name_en`（英文）
- 胜率引用规范：带 `win_rate_ci95_pp`（95% 置信区间 ±pp）；`low_sample: true` 的行只能定性（"方向上克制"），不能报精确百分比

## 一键模板

MCP 注册了 4 个 prompt（客户端斜杠菜单可触发）：`match-analysis`、`player-review`、`hero-guide`、`meta-report`——已内置上述完整流程。

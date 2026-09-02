import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STRATZ_ENABLED } from "./stratz.js";

/**
 * MCP prompts: ready-made workflow instructions the client can trigger
 * (slash menu in Claude Desktop, prompt picker in openclaw). They encode
 * the playbooks validated during E2E testing — which tools to call, in
 * what order, and how to interpret the enriched fields — so agents don't
 * have to rediscover the analysis path each time.
 */

const LANG = z.string().optional().describe("Language for names, e.g. 'schinese'/'zh-CN'.");
const langLine = (lang?: string) => `所有英雄/物品/技能名称用${lang ?? "schinese"}输出（name 字段），保留英文名对照。`;

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "match-analysis",
    "Full post-game breakdown of one match: timeline, lane outcomes, draft, per-position performance, blame analysis.",
    {
      match_id: z.string().describe("The match id to analyze."),
      focus_account_id: z
        .string()
        .optional()
        .describe("An account id in the match to focus the analysis on (usually the asking player)."),
      language: LANG,
    },
    ({ match_id, focus_account_id, language }) =>
      userPrompt(`请完整复盘 Dota 2 比赛 ${match_id}，按以下工作流（数据全部来自 opendota MCP 工具，不要凭记忆编造）：

1. get_match_coaching(match_id=${match_id}${focus_account_id ? `, focus_account_id=${focus_account_id}` : ""})${STRATZ_ENABLED ? "" : "（STRATZ 未配置时跳过此步）"}
   → 一键教练报告：阵容画像（伤害构成/控制集中/续航）、每人 vs 分段基准（vs_bracket_avg_pct）、
   时间窗判决（timing_verdict）、coach_notes。复盘从这里开始。
2. get_match(match_id=${match_id}, language="${language ?? "schinese"}", include={picks_bans:true, graphs:true})
   - 先看 parsed 字段：如果为 false，先 request_match_parse(match_id) 等解析完成再重新 get_match 加 include={teamfights:true, objectives:true}
3. 比赛叙事：用 losing_team_max_gold_lead/deficit 和 radiant_gold_advantage_by_minute 找转折点分钟数
4. 分路结论：每个玩家的 lane_result（won/lost/draw，官方 Story 口径）+ position + lane_efficiency_pct
5. 定责方法：优先用 get_match_coaching 的 vs_bracket_avg_pct（低于分段常态的维度），
   结合 position 对位比经济/参团率/伤害；position_basis 不是 "position_est"/"official_algorithm" 时说明这是推测
6. ${focus_account_id ? `重点关注 account_id=${focus_account_id}：出装时间线（items 的 purchased_at）、技能加点、死亡原因（breakdown 的 killed_by）` : "选出全场 MVP 和最大问题点"}
7. 出装审查：对照对面阵容检查关键针对装（闪避→MKB、回复→治疗削减等），用 get_item_details 查不确定的物品效果${STRATZ_ENABLED ? "；可疑的关键装备用 get_item_winrate_vs_hero 查该对位出/不出的胜率差" : ""}
8. 结论：输/赢的 2-3 个根本原因，每条附数据证据 + 每条给一个下局可执行的改进

${langLine(language ?? "schinese")}`),
  );

  server.prompt(
    "player-review",
    "Recent form review for one player: win rates, hero pool, rank trend, and concrete improvement advice.",
    {
      account_id: z.string().describe("The player's account id."),
      language: LANG,
    },
    ({ account_id, language }) =>
      userPrompt(`请为 Dota 2 玩家 account_id=${account_id} 做近期状态体检（数据全部来自 opendota MCP）：

1. get_player → 段位徽章、computed_mmr、turbo_mmr、国家
2. get_player_recent_matches → 最近 20 场胜率、KDA 趋势、常用英雄
3. get_player_win_loss(date=30) + get_player_heroes(date=30) → 30 天英雄池与胜率排序
4. get_player_counts → 分路偏好（lane_role 分布）
5. 选 1-2 场代表性败局用 get_match 复盘关键问题（不要逐场）
6. 输出：状态总结（上升趋势/下滑）、本命英雄 vs 拖后腿英雄（场次够多才算数）、2-3 条可执行改进建议

${langLine(language ?? "schinese")}`),
  );

  server.prompt(
    "hero-guide",
    "Complete guide for one hero: abilities, talents, facets, matchups, item builds, and when to pick it in the current patch.",
    {
      hero: z.string().describe("Hero id or name, e.g. 1 / 'Anti-Mage' / '敌法师'."),
      language: LANG,
    },
    ({ hero, language }) =>
      userPrompt(`请为英雄 ${hero} 制作当前版本的完全攻略（数据全部来自 opendota MCP，禁止凭记忆描述技能）：

1. get_hero_kit(hero="${hero}") → 技能说明/魔耗/冷却/数值、天赋树、facets（向用户解释每个技能机制）
2. get_hero_stats → 该英雄各分段胜率 + 选取率（判断当前版本强度）${STRATZ_ENABLED ? "；get_hero_trend → 版本走势（是否被削）" : ""}
3. ${STRATZ_ENABLED ? "get_matchups_by_rank + get_lane_matchups（按用户分段过滤；引用胜率必须带 win_rate_ci95_pp）→ 克制/被克与对线难易" : "get_hero_matchups → 最克制谁（胜率最高的对位）和被谁克（胜率最低的）"}
4. ${STRATZ_ENABLED ? "get_item_builds_by_rank + get_talent_stats（分段+位置过滤）→ 核心出装时间线与天赋选择胜率" : "get_hero_item_popularity + get_item_details → 分阶段出装（开始/前期/中期/后期），解释核心装备作用"}
5. get_hero_duration_performance → 时长胜率曲线（前期核还是后期核）
6. 综合：适合什么局面选、什么局面对线难受、连招/加点顺序建议（基于技能数值，不要编造）

${langLine(language ?? "schinese")}`),
  );

  server.prompt(
    "meta-report",
    "Current patch meta report: strongest heroes by bracket, pro picks/bans, and rising trends.",
    { language: LANG },
    ({ language }) =>
      userPrompt(`请基于 opendota MCP 生成当前版本环境报告：

1. get_hero_stats → 按各分段（ Herald→Immortal）胜率排出强势/弱势英雄各 5 名，注意区分分段差异
2. get_hero_stats 的 pro_pick/pro_ban → 职业 BP 热门
3. get_pro_matches → 最近职业赛结果与趋势（时长、比分特征）
4. get_live_matches → 抽查当前直播局的出场英雄印证趋势
5. 输出：分段上分推荐（低分/中分/高分各给英雄+理由）、职业圈信号、避雷英雄

${langLine(language ?? "schinese")}`),
  );
}

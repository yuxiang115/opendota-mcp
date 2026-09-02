# opendota-mcp

[中文文档](README.zh-CN.md)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives LLMs and agents direct access to **Dota 2 data** through the [OpenDota API](https://docs.opendota.com) — with full **data mapping** (every hero/item/ability id resolved to names, every enum to human-readable labels) and **28-language localization** of game-entity names.

Built so an agent can answer questions like *"敌法师克制哪些英雄？"*, *"What did SumaiL play in his last 5 ranked matches?"*, or *"Show me the latest pro matches and break down the draft"* — without ever seeing a raw numeric id.

## Highlights

- **42 tools** covering the whole public OpenDota API: matches, players, heroes, teams, pro scene, leagues, live games, constants, search, and replay-parse submission.
- **Data mapping for LLMs** — responses are compact and readable out of the box:
  - `hero_id: 53` → `hero: { id: 53, name: "自然先知", name_en: "Nature's Prophet" }`
  - `game_mode: 22` → `"All Draft"`, `lobby_type: 7` → `"Ranked"`, `rank_tier: 55` → `"Legend 5"`
  - durations → `"37:22"`, timestamps → ISO, per-player KDA/win/side computed, win rates pre-calculated
- **28 languages** for hero/item/ability names (English, 简体中文, 繁體中文, Русский, Español, Português, Français, Deutsch, 日本語， 한국어, ไทย, Tiếng Việt, Türkçe, + more), generated from Valve's official localized game data. Per-tool `language` parameter or a global default via env.
- **Agent-friendly entry points**: `search_dota_entities` resolves any localized or English name ("敌法师", "blink dagger", "祈求者") to the ids other tools need; `search_players` finds account ids by display name.
- **Polite API client**: built-in token-bucket rate limiting (respects the 60/min free tier), response caching, 429 handling, and optional `OPENDOTA_API_KEY` support.

## Quick start

Requirements: Node.js ≥ 18.

```bash
git clone https://github.com/yuxiang115/opendota-mcp.git
cd opendota-mcp
npm install
npm run build
node dist/index.js   # starts the MCP server on stdio
```

Or run directly once published / from the repo with npx:

```bash
npx opendota-mcp
# or from a checkout
npx .
```

### Install the Agent Skill (recommended)

The package ships an [Agent Skill](./skill/SKILL.md) (`skill/SKILL.md`) that teaches
the host agent the full Dota analysis playbook (which tools to call, how to read
enriched fields, rank-bracket data boundaries). Skills are loaded by the **host
application**, not the MCP server, so after adding the server run:

```bash
npx opendota-mcp install-skill          # auto-detects installed hosts
npx opendota-mcp install-skill all      # force every supported host
npx opendota-mcp install-skill zcode    # or pick: claude-code | zcode | openclaw
```

Manual equivalent if you prefer:

| Host | Where the skill goes |
|---|---|
| Claude Code | `~/.claude/skills/opendota/SKILL.md` |
| ZCode | `~/.agents/skills/opendota/SKILL.md` |
| openclaw | `openclaw skills install <repo>/skill` |
| No install yet | `curl -fsSL https://raw.githubusercontent.com/yuxiang115/opendota-mcp/main/skill/SKILL.md -o SKILL.md` |

Restart the host (or start a new session) afterwards. Everything works without
the skill too — it just shortens the agent's path to the right tools.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENDOTA_API_KEY` | *(none)* | Your [OpenDota API key](https://www.opendota.com/api-keys) — raises the rate limit from 60/min to 3000/min. |
| `OPENDOTA_LANGUAGE` | `english` | Default language for hero/item/ability names. Accepts Steam codes (`schinese`) or tags (`zh-CN`). |
| `OPENDOTA_BASE_URL` | `https://api.opendota.com/api` | Point at a self-hosted OpenDota instance if you run one. |
| `OPENDOTA_RATE_LIMIT` | `55` (or `1200` with a key) | Max requests/minute the client will send. |
| `STRATZ_API_TOKEN` | *(none)* | **Enables the STRATZ tools.** Free token from [stratz.com/api](https://stratz.com/api) (Steam login). Adds 6 rank-bracket/position-split aggregate tools (see below). |
| `STRATZ_BASE_URL` | `https://api.stratz.com/graphql` | Override for testing. |

### STRATZ-powered bracket stats (optional)

OpenDota's public scenario endpoints no longer filter by rank bracket and its
hero-vs-hero aggregates draw from a small parsed-match sample (~100 games per
pairing). When `STRATZ_API_TOKEN` is set, six additional tools register,
backed by [STRATZ](https://stratz.com)'s GraphQL API with full-pool samples
(tens of thousands of games) and bracket/position filters:

| Tool | Answers |
|---|---|
| `get_matchups_by_rank` | Who does a hero beat / lose to **at a given bracket** (with 95% CIs). |
| `get_item_builds_by_rank` | Which items a hero buys at a bracket/position, average purchase minute, and win rate. |
| `get_talent_stats` | Which talent choice actually wins, per bracket/position. |
| `get_lane_matchups` | Lane-phase outcomes (win/loss/draw) vs each opponent hero. |
| `get_draft_advice` | Given the enemy lineup (+ your allies), ranks counter picks with per-enemy win rates and ally synergy. |
| `get_hero_trend` | Win rate per patch (all 8 brackets supported) — is the hero still good after the nerf? |

Brackets map to STRATZ's tiers (`herald_guardian` … `divine_immortal`); the
trend tool supports all 8 fine brackets. All win rates are recomputed from raw
counts and every row carries `win_rate_ci95_pp` / `low_sample` so agents quote
numbers honestly. STRATZ requests are cached (30 min) and rate-throttled.

### Claude Code

```bash
claude mcp add opendota -- npx opendota-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Stores → Claude Desktop → config):

```json
{
  "mcpServers": {
    "opendota": {
      "command": "npx",
      "args": ["opendota-mcp"],
      "env": {
        "OPENDOTA_LANGUAGE": "english"
      }
    }
  }
}
```

### Cursor / other MCP clients

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

> **Windows note**: Claude Desktop (and some other clients) cannot spawn `npx` directly on Windows — use the `cmd /c` wrapper instead:
>
> ```json
> { "command": "cmd", "args": ["/c", "npx", "-y", "opendota-mcp"] }
> ```
>
> This pattern is covered by the integration test (`npm run integration`).

## Tools

### Lookup & system

| Tool | Description |
|---|---|
| `search_dota_entities` | Resolve hero/item/ability **names** (English or any supported localized name) to numeric ids. Start here. |
| `search_players` | Find players by display name → account ids. |
| `list_supported_languages` | All available localization languages. |
| `get_api_health` | OpenDota service health. |
| `get_constants` | Raw OpenDota constants resource (heroes, items, item_ids, abilities, ability_ids, game_mode, lobby_type, region, patch, ...). |

### Matches

| Tool | Description |
|---|---|
| `get_match` | Full match detail as a compact enriched view (heroes/items/abilities named, KDA/GPM/XPM per player, optional picks_bans/teamfights/objectives/chat/graphs/logs via `include`). |
| `request_match_parse` | Submit a match for replay parsing and poll until finished (default waits 45s; deep data then available via `get_match`). |
| `get_parse_job_status` | Poll a parse job. |

### Players

All player-match tools accept the standard OpenDota filters (`hero_id`, `game_mode`, `patch`, `date`, `win`, `lane_role`, `with_hero_id`, `against_hero_id`, `limit/offset`, ...). One deliberate default change: this server sends `significant=0` (ALL game modes, **Turbo included**) where OpenDota's own default silently hides Turbo games — pass `significant=1` for standard-mode-only stats.

| Tool | Description |
|---|---|
| `get_player` | Profile + rank medal ("Immortal", "Legend 3") + MMR estimate. |
| `get_player_recent_matches` | ~20 most recent matches, enriched. |
| `get_player_matches` | Filtered match history. |
| `get_player_win_loss` | Win/loss counts + win rate. |
| `get_player_heroes` | Most-played heroes with win rates. |
| `get_player_peers` | Most-played-with players. |
| `get_player_pros` | Pro players encountered. |
| `get_player_totals` | Lifetime aggregates (kills, gold, damage...). |
| `get_player_counts` | Matches by mode/lobby/lane/region/patch (ids resolved). |
| `get_player_histogram` | Distribution of one stat. |
| `get_player_wardmap` | Ward placement heatmap. |
| `get_player_wordcloud` | Chat word counts. |
| `get_player_rating_history` | Rank medal history. |
| `get_player_hero_rankings` | Hero leaderboard percentiles. |
| `refresh_player` | Ask OpenDota to refresh a player's history. |

### Heroes

| Tool | Description |
|---|---|
| `get_heroes` | All heroes with localized names, attributes, roles, base stats. |
| `get_hero_kit` | **Full ability reference for a hero** (accepts id or name, any language): every ability with description, mana cost, cooldown, per-level numbers, Aghanim's flags, plus all talents and non-deprecated facets — no more guessing what newer heroes do. |
| `get_item_details` | **Item reference for up to 10 items** (id/name, any language): cost, active/passive effects, stat attributes, cooldown/mana, components. |
| `get_hero_stats` | Pick/ban/win rates by bracket (Herald→Immortal, pro, turbo). |
| `get_hero_matchups` | Counter relationships vs every other hero (win rates). |
| `get_hero_recent_matches` | Recent public matches on a hero. |
| `get_hero_benchmarks` | Percentile benchmarks by rank bracket. |
| `get_hero_item_popularity` | Items by game phase, named. |
| `get_item_winrate_vs_hero` | **Item win rate against one specific enemy** (explorer cross-tab): with/without comparison per item, or the matchup's most common final-build items ranked. |
| `get_hero_duration_performance` | Win rate by game-duration bin. |
| `get_hero_players` | Top players of a hero. |
| `get_hero_rankings` | Global hero leaderboard. |

### Teams, pro scene & live

| Tool | Description |
|---|---|
| `get_teams` / `get_team` | Pro teams by rating / one team's profile. |
| `get_team_matches` / `get_team_players` / `get_team_heroes` | Team match history, roster, hero pool. |
| `get_pro_matches` | Latest professional matches. |
| `get_pro_players` | Registered pro players. |
| `get_leagues` / `get_league_matches` | Leagues and their matches. |
| `get_live_matches` | Top live games with heroes and ranks. |

## Localization

Hero, item and ability names are localized into **28 languages**, generated from Valve's official localized Dota 2 data feeds (`npm run build:locales` regenerates the tables in `locales/`):

english, schinese (简体中文)， tchinese (繁體中文)， japanese, koreana, russian, spanish, latam, brazilian, portuguese, french, german, italian, turkish, polish, czech, danish, dutch, finnish, greek, hungarian, norwegian, romanian, swedish, thai, vietnamese, ukrainian, bulgarian.

Pass `language` on any tool that returns game-entity names (`"schinese"`, `"zh-CN"`, `"ru"`, ...), or set `OPENDOTA_LANGUAGE` globally. Every name field is returned as `{ name: <localized>, name_en: <English> }` so agents can cross-reference guides in either language.

## Example: enriched match view

`get_match(match_id=8978292022, language="schinese")` returns (abridged):

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

## Development

```bash
npm install
npm run build           # compile src/ → dist/
npm run build:locales   # re-fetch Valve localization feeds → locales/
npm run integration     # end-to-end tests over stdio (incl. mock-upstream regression tests)
npm run smoke           # quick end-to-end pass with real API calls
npm run check           # typecheck only
```

Game constants are bundled with the package (`constants-bundle/`, regenerated by `npm run build:data` and refreshed daily by CI). At boot the server sends a single patch-probe request and compares it to the bundle: matching means the seeded constants are used with zero further fetches, while a newer patch (new heroes/items always ship with one) triggers an immediate background refresh. Entries then refresh hourly via stale-while-revalidate. Typical upstream cost: **cold start + a fully-enriched match analysis = 2 requests**; repeat questions about the same match = 0. A `constants-bundle` miss simply falls back to fetching everything from the API.

**The bundle updates itself**: every successful network fetch of a constants resource is written back into `constants-bundle/` (best-effort — read-only installs such as npx caches silently keep the shipped copy), and the manifest's `max_patch_id` advances with it. So the seed gets fresher the longer the server runs; users never need to update anything manually. `OPENDOTA_BUNDLE_PERSIST=0` disables write-back.

Project layout:

```
src/
├── index.ts        # stdio MCP server entry, tool registration
├── config.ts       # env handling
├── client.ts       # OpenDota HTTP client: rate limiting, caching, errors
├── constants.ts    # OpenDota constants loaders + enum labels
├── locales.ts      # 28-language name tables + language normalization
├── mapping.ts      # id→name resolution, enum→label, row enrichment
├── enrich.ts       # match/heroStats/itemPopularity transformers
└── tools/          # tool definitions by domain
locales/            # generated name tables (one dir per language)
scripts/            # build-locales, smoke test
```

## Attribution

- Data: [OpenDota API](https://www.opendota.com) — an open Dota 2 data platform.
- Bracket-split aggregates (optional): [STRATZ API](https://stratz.com/api) — free GraphQL Dota 2 statistics.
- Localized names: Valve's official Dota 2 data feeds.
- Dota 2 is a trademark of Valve Corporation. This project is not affiliated with Valve, OpenDota or STRATZ.

## License

[MIT](LICENSE)

import { z } from "zod";
import { apiGet } from "../client.js";
import { getCountries } from "../constants.js";
import { gameModeName, heroRef, laneRoleLabel, lobbyTypeName, patchName, rankTierToLabel, regionName, enrichPlayerMatchRow, formatTimestamp } from "../mapping.js";
import { effectiveLanguage, languageParam, playerFilterShape, toQuery, type ToolDef } from "./registry.js";

const accountId = z
  .number()
  .int()
  .positive()
  .describe("Steam32 account id (the number after /players/ in an OpenDota profile URL, or from search_players).");

function filtersOf(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(playerFilterShape)) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  // Server default: include ALL game modes (Turbo included). OpenDota's own default
  // (significant=1) silently hides Turbo games, which reads as "player hasn't played".
  if (out.significant === undefined) out.significant = 0;
  return out;
}

export const playerTools: ToolDef[] = [
  {
    name: "search_players",
    description:
      "Search Dota 2 players by display name (personaname). Returns account ids usable with the player tools. " +
      "For a Steam profile URL, the account id is the trailing number.",
    schema: {
      q: z.string().min(1).describe("Name fragment to search for."),
    },
    handler: async (args) => {
      return apiGet("/search", { query: { q: args.q }, ttl: "listing" });
    },
  },
  {
    name: "get_player",
    description:
      "Get a player's profile and current competitive standing: display name, avatar, country, rank medal " +
      "(e.g. 'Immortal', 'Legend 3'), leaderboard position, MMR estimate.",
    schema: {
      account_id: accountId,
    },
    handler: async (args) => {
      const data = await apiGet<Record<string, any>>(`/players/${args.account_id}`, { ttl: "listing" });
      let country: string | undefined;
      try {
        const code = data.profile?.loccountrycode;
        if (code) {
          country = (await getCountries())[code]?.name?.common;
        }
      } catch {
        /* countries table unavailable */
      }
      return {
        ...data,
        country,
        rank_tier: rankTierToLabel(data.rank_tier, data.leaderboard_rank),
        rank_tier_raw: data.rank_tier,
        leaderboard_rank: data.leaderboard_rank,
      };
    },
  },
  {
    name: "get_player_recent_matches",
    description:
      "Get a player's ~20 most recent matches (regardless of filters), enriched with hero names, win/loss, " +
      "KDA, game mode, skill bracket.",
    schema: {
      account_id: accountId,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/recentMatches`, { ttl: "listing" });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(rows.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_player_matches",
    description:
      "Get a player's rated match history with rich filters (hero, game mode, patch, date range, side, with/against " +
      "heroes, ...). Each row is enriched with hero name, win/loss, game mode label. For summaries use " +
      "get_player_win_loss or get_player_heroes instead.",
    schema: {
      account_id: accountId,
      language: languageParam,
      project: z
        .string()
        .optional()
        .describe("Comma-separated fields to return (e.g. 'hero_id,start_time,kills,deaths,assists') to trim output."),
      ...playerFilterShape,
    },
    handler: async (args, ctx) => {
      const query = toQuery({ ...filtersOf(args), project: args.project });
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/matches`, { query, ttl: "listing" });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(rows.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_player_win_loss",
    description: "Get a player's win/loss counts (with the same filters as get_player_matches) plus win rate.",
    schema: {
      account_id: accountId,
      ...playerFilterShape,
    },
    handler: async (args) => {
      const wl = await apiGet<{ win: number; lose: number }>(`/players/${args.account_id}/wl`, {
        query: toQuery(filtersOf(args)),
        ttl: "listing",
      });
      const total = (wl.win ?? 0) + (wl.lose ?? 0);
      return { ...wl, total, win_rate_pct: total > 0 ? Math.round(((wl.win ?? 0) / total) * 1000) / 10 : undefined };
    },
  },
  {
    name: "get_player_heroes",
    description:
      "Heroes a player has played (with the standard filters), with hero names, games, wins, win rate, " +
      "and with/against splits.",
    schema: {
      account_id: accountId,
      language: languageParam,
      ...playerFilterShape,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/heroes`, {
        query: toQuery(filtersOf(args)),
        ttl: "listing",
      });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(
        rows.map(async (row) => {
          const hero = await heroRef(row.hero_id, lang);
          const games = (row.games ?? 0) as number;
          const win = (row.win ?? 0) as number;
          return { ...row, hero, win_rate_pct: games > 0 ? Math.round((win / games) * 1000) / 10 : undefined };
        }),
      );
    },
  },
  {
    name: "get_player_peers",
    description: "Players this player has played with most: names, games together, wins, win rate.",
    schema: {
      account_id: accountId,
      limit: playerFilterShape.limit,
    },
    handler: async (args) => {
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/peers`, {
        query: toQuery({ limit: args.limit }),
        ttl: "listing",
      });
      return rows.map((row) => {
        const games = (row.games ?? 0) as number;
        return {
          account_id: row.account_id,
          personaname: row.personaname ?? row.name,
          last_played: formatTimestamp(row.last_played),
          games,
          wins: row.win,
          win_rate_pct: games > 0 ? Math.round((row.win / games) * 1000) / 10 : undefined,
          with_games: row.with_games,
          against_games: row.against_games,
        };
      });
    },
  },
  {
    name: "get_player_pros",
    description: "Professional players this player has played with or against, with team affiliations.",
    schema: {
      account_id: accountId,
      limit: playerFilterShape.limit,
    },
    handler: async (args) => {
      return apiGet(`/players/${args.account_id}/pros`, {
        query: toQuery({ limit: args.limit }),
        ttl: "listing",
      });
    },
  },
  {
    name: "get_player_totals",
    description:
      "Lifetime aggregate totals for a player (kills, deaths, assists, last hits, gold, damage, ... as field/sum pairs).",
    schema: {
      account_id: accountId,
      ...playerFilterShape,
    },
    handler: async (args) => {
      return apiGet(`/players/${args.account_id}/totals`, { query: toQuery(filtersOf(args)), ttl: "listing" });
    },
  },
  {
    name: "get_player_counts",
    description:
      "Match counts broken down by leaver status, game mode, lobby type, lane role, region and patch, " +
      "with ids resolved to readable names.",
    schema: {
      account_id: accountId,
      ...playerFilterShape,
    },
    handler: async (args) => {
      const counts = await apiGet<Record<string, Record<string, number>>>(`/players/${args.account_id}/counts`, {
        query: toQuery(filtersOf(args)),
        ttl: "listing",
      });
      const resolveKeys = async (
        table: Record<string, number>,
        resolver: (id: number) => Promise<string | undefined>,
      ): Promise<Record<string, number>> => {
        const out: Record<string, number> = {};
        for (const [id, count] of Object.entries(table ?? {})) {
          const name = (await resolver(Number(id))) ?? id;
          out[name] = count;
        }
        return out;
      };
      return {
        leaver_status: counts.leaver_status,
        game_mode: await resolveKeys(counts.game_mode, gameModeName),
        lobby_type: await resolveKeys(counts.lobby_type, lobbyTypeName),
        lane_role: await resolveKeys(counts.lane_role, (id) => Promise.resolve(laneRoleLabel(id))),
        region: await resolveKeys(counts.region, regionName),
        patch: await resolveKeys(counts.patch, patchName),
      };
    },
  },
  {
    name: "get_player_histogram",
    description:
      "Distribution of one stat for a player, e.g. wins per x-value. Common fields: kills, deaths, assists, " +
      "gold_per_min, xp_per_min, last_hits, hero_damage, duration, lane_role, leaver_status, game_mode.",
    schema: {
      account_id: accountId,
      field: z.string().describe("Stat field to histogram, e.g. 'kills', 'gold_per_min', 'duration'."),
      ...playerFilterShape,
    },
    handler: async (args) => {
      const { field, ...rest } = args;
      return apiGet(`/players/${args.account_id}/histograms/${encodeURIComponent(String(field))}`, {
        query: toQuery(filtersOf(rest)),
        ttl: "listing",
      });
    },
  },
  {
    name: "get_player_wardmap",
    description:
      "Ward placement heatmap for a player: total observer/sentry counts plus the raw position maps " +
      "(keys are x,y on a 64x64 grid — divide by 64 for map fraction; game coords = value*range/64).",
    schema: {
      account_id: accountId,
      ...playerFilterShape,
    },
    handler: async (args) => {
      // Structure is nested: { "<row>": { "<col>": count } } on a 64x64 grid.
      const data = await apiGet<{ obs?: Record<string, Record<string, number>>; sen?: Record<string, Record<string, number>> }>(
        `/players/${args.account_id}/wardmap`,
        { query: toQuery(filtersOf(args)), ttl: "listing" },
      );
      const total = (m?: Record<string, Record<string, number>>) =>
        Object.values(m ?? {}).reduce((s, row) => s + Object.values(row ?? {}).reduce((a, b) => a + b, 0), 0);
      return {
        observer_wards_total: total(data.obs),
        sentry_wards_total: total(data.sen),
        observer_positions: data.obs,
        sentry_positions: data.sen,
      };
    },
  },
  {
    name: "get_player_wordcloud",
    description:
      "Words said in this player's matches, sorted by count: words by the player (my_words) and by everyone " +
      "(all_words). Useful for chat-toxicity or tilt flavor.",
    schema: {
      account_id: accountId,
      ...playerFilterShape,
      limit: z.number().int().min(1).max(200).optional().describe("Top N words per list (default 50)."),
    },
    handler: async (args) => {
      const data = await apiGet<{ my_word_counts?: Record<string, number>; all_word_counts?: Record<string, number> }>(
        `/players/${args.account_id}/wordcloud`,
        { query: toQuery(filtersOf(args)), ttl: "listing" },
      );
      const cap = args.limit ?? 50;
      const top = (m?: Record<string, number>) =>
        Object.entries(m ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, cap)
          .map(([word, count]) => ({ word, count }));
      return { my_words: top(data.my_word_counts), all_words: top(data.all_word_counts) };
    },
  },
  {
    name: "get_player_rating_history",
    description: "History of a player's rank medal changes over time (rank_tier snapshots per match).",
    schema: {
      account_id: accountId,
    },
    handler: async (args) => {
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/ratings`, { ttl: "listing" });
      return rows.map((row) => ({
        match_id: row.match_id,
        time: formatTimestamp(row.time),
        rank_tier: rankTierToLabel(row.rank_tier),
        rank_tier_raw: row.rank_tier,
      }));
    },
  },
  {
    name: "get_player_hero_rankings",
    description: "A player's hero leaderboard rankings (top-100 percentile scores per hero), with hero names.",
    schema: {
      account_id: accountId,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/rankings`, { ttl: "listing" });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(
        rows.map(async (row) => ({
          hero: await heroRef(row.hero_id, lang),
          score: row.score,
          percent_rank: row.percent_rank,
        })),
      );
    },
  },
  {
    name: "refresh_player",
    description:
      "Ask OpenDota to refresh a player's match history (up to ~500 recent matches), medal and profile name. " +
      "Use when a player's data looks stale, then re-query. Counts as 1 API call.",
    schema: {
      account_id: accountId,
    },
    handler: async (args) => {
      return apiGet(`/players/${args.account_id}/refresh`, { method: "POST" });
    },
  },
];

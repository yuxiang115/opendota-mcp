import { z } from "zod";
import { apiGet } from "../client.js";
import { enrichHeroMatchupRow, enrichHeroStatRow, enrichItemPopularity } from "../enrich.js";
import { getLocaleBundle } from "../locales.js";
import { enrichPlayerMatchRow, heroRef, rankTierToLabel } from "../mapping.js";
import { bracketLabel } from "../constants.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

const heroIdParam = z
  .number()
  .int()
  .positive()
  .describe("Hero id (resolve names to ids first with search_dota_entities, e.g. '敌法师' -> 1).");

export const heroTools: ToolDef[] = [
  {
    name: "get_heroes",
    description:
      "List all Dota 2 heroes with names (localized + English), primary attribute, attack type, roles, " +
      "and base stats. Good starting point for hero questions.",
    schema: {
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroes = await apiGet<Record<string, any>[]>("/heroStats", { ttl: "constants" });
      return heroes.map((h) => ({
        id: h.hero_id ?? h.id,
        name: heroDisplayName(h, lang),
        name_en: h.localized_name,
        primary_attr: h.primary_attr,
        attack_type: h.attack_type,
        roles: h.roles,
        base_health: h.base_health,
        base_mana: h.base_mana,
        base_armor: h.base_armor,
        base_attack_min: h.base_attack_min,
        base_attack_max: h.base_attack_max,
        move_speed: h.move_speed,
        legs: h.legs,
      }));
    },
  },
  {
    name: "get_hero_stats",
    description:
      "Hero pick/ban counts and win rates across brackets (Herald→Immortal, pro, turbo) in a COMPACT form: " +
      "per-bracket win-rate percentages plus pro/turbo pick counts, sorted by overall picks descending. " +
      "Set raw=true for the full counters (much larger). Pass top to limit rows (default all 127).",
    schema: {
      language: languageParam,
      top: z.number().int().min(1).max(130).optional().describe("Max heroes to return (default all)."),
      raw: z.boolean().optional().describe("Include raw per-bracket pick/win counters (large)."),
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>("/heroStats", { ttl: "constants" });
      const lang = effectiveLanguage(args.language, ctx);
      const enriched = await Promise.all(rows.map((row) => enrichHeroStatRow(row, lang, args.raw === true)));
      const sorted = enriched.sort((a, b) => (b.overall_pick as number ?? 0) - (a.overall_pick as number ?? 0));
      return args.top ? sorted.slice(0, args.top) : sorted;
    },
  },
  {
    name: "get_hero_matchups",
    description:
      "How a hero performs against every other hero (games played and win rate from public matches). " +
      "The classic 'counters' lookup — low win_rate vs a hero means that hero counters this one. " +
      "NOTE: aggregated across ALL rank brackets (source has no bracket filter); bracket-specific " +
      "counter meta is not available — use get_hero_stats for bracket-specific strength.",
    schema: {
      hero_id: heroIdParam,
      language: languageParam,
      limit: z.number().int().min(1).max(130).optional().describe("Max opposing heroes to return (default all)."),
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/heroes/${args.hero_id}/matchups`, { ttl: "match" });
      const lang = effectiveLanguage(args.language, ctx);
      const limited = args.limit ? rows.slice(0, args.limit) : rows;
      return Promise.all(limited.map((row) => enrichHeroMatchupRow(row, lang)));
    },
  },
  {
    name: "get_hero_recent_matches",
    description: "Recent public matches on a hero (per-player rows: account id, rank, KDA, items-lite), enriched.",
    schema: {
      hero_id: heroIdParam,
      language: languageParam,
      limit: z.number().int().min(1).max(100).optional().describe("Max matches to return."),
    },
    handler: async (args, ctx) => {
      const rows = await apiGet<Record<string, any>[]>(`/heroes/${args.hero_id}/matches`, { ttl: "listing" });
      const lang = effectiveLanguage(args.language, ctx);
      const limited = args.limit ? rows.slice(0, args.limit) : rows;
      return Promise.all(limited.map((row) => enrichPlayerMatchRow(row, lang)));
    },
  },
  {
    name: "get_hero_benchmarks",
    description:
      "Benchmarks for a hero: what various percentiles of players achieve (last hits, kills, GPM, ...) " +
      "by rank bracket (1 Herald ... 8 Immortal; omit for all).",
    schema: {
      hero_id: heroIdParam,
      bracket: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Rank bracket 1-8 (Herald..Immortal). Omit for all public matches."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const data = await apiGet<Record<string, any>>("/benchmarks", {
        query: { hero_id: args.hero_id, bracket: args.bracket },
        ttl: "constants",
      });
      const hero = await heroRef(args.hero_id, lang);
      return {
        hero,
        bracket: args.bracket,
        bracket_label: bracketLabel(args.bracket, lang) ?? "all public matches (no bracket filter)",
        benchmarks: data?.result,
        note:
          "values are what the given percentile of players achieves (last hits @10 min, GPM, XPM, kills, ...); " +
          "top brackets can be null upstream when the sample is sparse",
      };
    },
  },
  {
    name: "get_hero_item_popularity",
    description:
      "Item popularity for a hero by game phase (start_game_items, early_game_items, mid_game_items, " +
      "late_game_items), with item names resolved. Aggregated across ALL rank brackets (no bracket filter).",
    schema: {
      hero_id: heroIdParam,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const data = await apiGet<Record<string, Record<string, number>>>(`/heroes/${args.hero_id}/itemPopularity`, {
        ttl: "constants",
      });
      const lang = effectiveLanguage(args.language, ctx);
      return enrichItemPopularity(data, lang);
    },
  },
  {
    name: "get_hero_duration_performance",
    description:
      "A hero's win rate binned by match duration bucket (in 5-minute bins: '0-5', '5-10', ...). " +
      "Shows hero power curve across game length. Aggregated across ALL rank brackets (no bracket filter).",
    schema: {
      hero_id: heroIdParam,
    },
    handler: async (args) => {
      const rows = await apiGet<Record<string, any>[]>(`/heroes/${args.hero_id}/durations`, { ttl: "constants" });
      return rows.map((row) => {
        const games = (row.games_played ?? 0) as number;
        return {
          duration_bin_minutes: row.duration_bin,
          games_played: games,
          wins: row.wins,
          win_rate_pct: games > 0 ? Math.round((row.wins / games) * 1000) / 10 : undefined,
        };
      });
    },
  },
  {
    name: "get_hero_players",
    description: "Players who have played a hero recently (account id, name, games, wins), with win rates.",
    schema: {
      hero_id: heroIdParam,
    },
    handler: async (args) => {
      const rows = await apiGet<Record<string, any>[]>(`/heroes/${args.hero_id}/players`, { ttl: "listing" });
      return rows.slice(0, 100).map((row) => {
        const games = (row.games_played ?? 0) as number;
        return {
          account_id: row.account_id,
          personaname: row.personaname,
          games_played: games,
          wins: row.wins,
          win_rate_pct: games > 0 ? Math.round((row.wins / games) * 1000) / 10 : undefined,
        };
      });
    },
  },
  {
    name: "get_hero_rankings",
    description: "Global top players on a hero (leaderboard scores and ranks).",
    schema: {
      hero_id: heroIdParam,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const rows = await apiGet<Record<string, any>[]>("/rankings", {
        query: { hero_id: args.hero_id },
        ttl: "listing",
      });
      return rows.map((row) => ({
        rank: row.rank,
        score: row.score,
        account_id: row.account_id,
        personaname: row.personaname,
        rank_tier: rankTierToLabel(row.rank_tier, undefined, lang),
        steam_id: row.steamid,
      }));
    },
  },
];

/** heroStats rows carry the English localized_name; prefer the locale bundle for other languages. */
function heroDisplayName(heroStatsRow: Record<string, any>, lang: string): string {
  const id = heroStatsRow.hero_id ?? heroStatsRow.id;
  return getLocaleBundle(lang).heroes[String(id)]?.name ?? heroStatsRow.localized_name;
}

import { z } from "zod";
import { apiGet } from "../client.js";
import { getCountries } from "../constants.js";
import { leaverStatusLabel } from "../mapping.js";
import { gameModeName, heroRef, laneRoleLabel, lobbyTypeName, patchName, rankTierToLabel, regionName, enrichPlayerMatchRow, formatTimestamp } from "../mapping.js";
import { sampleFields } from "../stats.js";
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
      "For a Steam profile URL, the account id is the trailing number. If the search service is unavailable, " +
      "ask the user for their OpenDota/DotaBuff profile link or Steam64 id instead of guessing account ids.",
    schema: {
      q: z.string().min(1).describe("Name fragment to search for."),
    },
    handler: async (args) => {
      try {
        return await apiGet("/search", { query: { q: args.q }, ttl: "listing", timeoutMs: 12_000 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          error: message,
          hint:
            "Player search failed. Do NOT guess account ids. Ask the user for an OpenDota/DotaBuff profile URL " +
            "(the number in /players/<id> is the account id) or their Steam64 id (subtract 76561197960265728 " +
            "to get the account id), then retry with get_player.",
        };
      }
    },
  },
  {
    name: "get_player",
    description:
      "Get a player's profile and current competitive standing: display name, avatar, country, rank medal " +
      "(e.g. 'Immortal', 'Legend 3'), leaderboard position, MMR estimate.",
    schema: {
      account_id: accountId,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const data = await apiGet<Record<string, any>>(`/players/${args.account_id}`, { ttl: "player" });
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
        rank_tier: rankTierToLabel(data.rank_tier, data.leaderboard_rank, lang),
        rank_tier_raw: data.rank_tier,
        leaderboard_rank: data.leaderboard_rank,
      };
    },
  },
  {
    name: "get_player_overview",
    description:
      "ONE-CALL player dashboard — the player's background context in a single response: profile + rank, " +
      "lifetime volume and win rate, recent form (last 20: streak, averages, mode mix), hero pool with " +
      "signature picks, lane-role distribution with win rates, top duo partners, and rank trend. " +
      "Use this FIRST for any 'how is this player / 这玩家怎么样 / 战绩如何' question instead of assembling " +
      "get_player + heroes + counts + recent matches yourself; the context_note says which tool drills deeper " +
      "for each follow-up.",
    schema: {
      account_id: accountId,
      recent: z.number().int().min(5).max(50).optional().describe("Recent-matches window size (default 20)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const id = args.account_id;
      const safe = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
      const [profile, wl, heroes, counts, recent, peersRaw, ratings] = await Promise.all([
        safe(apiGet<Record<string, any>>(`/players/${id}`, { ttl: "player" })),
        // significant=0 keeps volume on the same all-modes denominator as
        // counts/by_mode below (OpenDota's default silently drops non-standard
        // modes like Turbo, producing a total that contradicts by_mode).
        safe(apiGet<Record<string, any>>(`/players/${id}/wl`, { query: { significant: 0 }, ttl: "player" })),
        safe(apiGet<Record<string, any>[]>(`/players/${id}/heroes`, { query: { significant: 0 }, ttl: "player" })),
        safe(apiGet<Record<string, any>>(`/players/${id}/counts`, { query: { significant: 0 }, ttl: "player" })),
        safe(apiGet<Record<string, any>[]>(`/players/${id}/recentMatches`, { ttl: "listing" })),
        // peers endpoint mangles ?limit — page locally (see get_player_peers).
        safe(apiGet<Record<string, any>[]>(`/players/${id}/peers`, { query: { significant: 0 }, ttl: "player" })),
        safe(apiGet<Record<string, any>[]>(`/players/${id}/ratings`, { ttl: "player" })),
      ]);

      const pct1 = (w: number, g: number) => (g > 0 ? Math.round((w / g) * 1000) / 10 : undefined);

      // ── profile & volume ──
      const wins = Number(wl?.win ?? profile?.win ?? 0);
      const losses = Number(wl?.lose ?? profile?.lose ?? 0);
      const rank = profile?.rank_tier as number | undefined;
      const overview: Record<string, unknown> = {
        player: {
          account_id: id,
          personaname: profile?.profile?.personaname ?? profile?.personaname,
          ...(profile?.profile?.loccountrycode ? { country: profile.profile.loccountrycode } : {}),
          rank_tier: rankTierToLabel(rank, profile?.leaderboard_rank, lang),
          mmr_estimate: profile?.mmr_estimate,
        },
        volume: {
          total_games: wins + losses,
          wins,
          losses,
          win_rate_pct: pct1(wins, wins + losses),
        },
      };

      // ── mode mix (top modes by games) ──
      if (counts?.game_mode) {
        const modes = await Promise.all(
          Object.entries(counts.game_mode as Record<string, { games: number; win: number }>).map(
            async ([modeId, c]) => ({
              mode: (await gameModeName(Number(modeId))) ?? `mode ${modeId}`,
              games: c.games,
              win_rate_pct: pct1(c.win, c.games),
            }),
          ),
        );
        modes.sort((a, b) => b.games - a.games);
        (overview.volume as Record<string, unknown>).by_mode = modes;
      }

      // ── recent form ──
      if (Array.isArray(recent) && recent.length > 0) {
        const window = args.recent ?? 20;
        const rows = [...recent]
          .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0))
          .slice(0, window);
        let wins2 = 0;
        let streakType: "W" | "L" | undefined;
        let streakLen = 0;
        const kdaAcc = [0, 0, 0];
        let gpmAcc = 0;
        let gpmN = 0;
        let xpmAcc = 0;
        let xpmN = 0;
        let partySum = 0;
        let partyGames = 0;
        const heroCount = new Map<number, { games: number; wins: number; name?: string }>();
        for (const m of rows) {
          const isRadiant = (m.player_slot as number) < 128;
          const win = m.radiant_win === isRadiant;
          if (win) wins2++;
          if (streakType == null) {
            streakType = win ? "W" : "L";
            streakLen = 1;
          } else if ((streakType === "W") === win) streakLen++;
          kdaAcc[0] += m.kills ?? 0;
          kdaAcc[1] += m.deaths ?? 0;
          kdaAcc[2] += m.assists ?? 0;
          if (m.gold_per_min != null) {
            gpmAcc += m.gold_per_min;
            gpmN++;
          }
          if (m.xp_per_min != null) {
            xpmAcc += m.xp_per_min;
            xpmN++;
          }
          if (m.party_size != null) {
            partySum += m.party_size;
            partyGames++;
          }
          const h = heroCount.get(m.hero_id as number) ?? { games: 0, wins: 0 };
          h.games++;
          if (win) h.wins++;
          heroCount.set(m.hero_id as number, h);
        }
        const recentHeroes = await Promise.all(
          [...heroCount.entries()]
            .sort((a, b) => b[1].games - a[1].games)
            .slice(0, 5)
            .map(async ([heroId, h]) => ({
              hero: (await heroRef(heroId, lang))?.name ?? `hero ${heroId}`,
              games: h.games,
              win_rate_pct: pct1(h.wins, h.games),
            })),
        );
        overview.recent_form = {
          window: rows.length,
          wins: wins2,
          losses: rows.length - wins2,
          win_rate_pct: pct1(wins2, rows.length),
          current_streak: streakType ? `${streakLen}${streakType}` : undefined,
          avg_kda: rows.length
            ? Math.round(((kdaAcc[0] + kdaAcc[2]) / Math.max(kdaAcc[1], 1)) * 100) / 100
            : undefined,
          avg_gpm: gpmN ? Math.round(gpmAcc / gpmN) : undefined,
          avg_xpm: xpmN ? Math.round(xpmAcc / xpmN) : undefined,
          avg_party_size: partyGames ? Math.round((partySum / partyGames) * 10) / 10 : undefined,
          top_heroes_in_window: recentHeroes,
        };
      }

      // ── hero pool (lifetime) ──
      if (Array.isArray(heroes) && heroes.length > 0) {
        const pool = await Promise.all(
          heroes.slice(0, 8).map(async (h) => {
            const games = Number(h.games ?? 0);
            const winRate = pct1(Number(h.win ?? 0), games);
            return {
              hero: (await heroRef(h.hero_id as number, lang))?.name ?? `hero ${h.hero_id}`,
              games,
              win_rate_pct: winRate,
              with_win_rate_pct: pct1(Number(h.with_win ?? 0), Number(h.with_games ?? 0)),
              last_played: h.last_played != null ? formatTimestamp(h.last_played as number) : undefined,
              signature: games >= 100 && (winRate ?? 0) >= 55,
            };
          }),
        );
        overview.hero_pool = pool;
      }

      // ── lane distribution ──
      if (counts?.lane_role) {
        // lane_role 0 = no lane data (Turbo/unparsed) — excluded from the
        // distribution, coverage reported instead of diluting the shares.
        const entries = Object.entries(counts.lane_role as Record<string, { games: number; win: number }>)
          .map(([lr, c]) => ({ lr: Number(lr), c }))
          .filter(({ lr }) => lr >= 1);
        const known = entries.reduce((s, e) => s + e.c.games, 0);
        const unknown = Number((counts.lane_role as Record<string, { games: number }>)["0"]?.games ?? 0);
        const lanes = await Promise.all(
          entries
            .sort((a, b) => b.c.games - a.c.games)
            .map(async ({ lr, c }) => ({
              lane_role: laneRoleLabel(lr),
              games: c.games,
              share_pct: known > 0 ? Math.round((c.games / known) * 1000) / 10 : undefined,
              win_rate_pct: pct1(c.win, c.games),
            })),
        );
        overview.lane_distribution = {
          lanes,
          note:
            unknown > 0
              ? `Shares are over ${known} matches WITH lane data (lane comes from replays); ${unknown} matches (Turbo/unparsed) carry none.`
              : undefined,
        };
      }

      // ── duo partners ──
      if (Array.isArray(peersRaw) && peersRaw.length > 0) {
        overview.duo_partners = (
          await Promise.all(
            peersRaw.slice(0, 3).map(async (p) => ({
              name: p.personaname ?? `account ${p.account_id}`,
              account_id: p.account_id,
              games: p.with_games,
              win_rate_pct: pct1(p.with_win ?? 0, p.with_games ?? 0),
            })),
          )
        ).filter((p) => p.games > 0);
      }

      // ── rank trend ──
      if (Array.isArray(ratings) && ratings.length > 0) {
        overview.rank_trend = ratings
          .slice(-6)
          .reverse()
          .map((r) => ({ time: formatTimestamp(r.time as number), rank_tier: rankTierToLabel(r.rank_tier as number, undefined, lang) }));
      }

      overview.context_note =
        "Snapshot dashboard for orientation. Drill down with: get_player_matches (filters), get_player_heroes " +
        "(full pool), get_player_peers/get_player_partnership (stack analysis), get_match_coaching (review one " +
        "game), get_hero_rankings (leaderboard). recent_form window uses OpenDota's recentMatches feed — it can " +
        "lag hours behind (Turbo especially); refresh_player forces an index update. Averages blend ALL modes — " +
        "check volume.by_mode first: Turbo games run ~2/3 length with much higher GPM/XPM, so a Turbo-heavy window " +
        "inflates them.";
      return overview;
    },
  },
  {
    name: "get_player_recent_matches",
    description:
      "Get a player's ~20 most recent matches (regardless of filters), enriched with hero names, win/loss, " +
      "KDA, game mode, skill bracket. OpenDota's index can lag (hours to days for Turbo/unranked) — if these " +
      "look older than the user's actual latest games, call refresh_player first, then re-query.",
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
      "get_player_win_loss or get_player_heroes instead. For bulk analysis over many games use " +
      "get_player_match_analytics (one request, server-side aggregation) — never call get_match per id.",
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
        ttl: "player",
      });
      const total = (wl.win ?? 0) + (wl.lose ?? 0);
      return { ...wl, total, win_rate_pct: total > 0 ? Math.round(((wl.win ?? 0) / total) * 1000) / 10 : undefined };
    },
  },
  {
    name: "get_player_match_analytics",
    description:
      "Bulk player-form analysis over recent matches, optionally a TIME WINDOW (from/to, e.g. this " +
      "month / this year) — " +
      "win rate + trend (first vs second half), current & longest streaks, per-hero table with KDA, " +
      "mode/party breakdowns, session pattern, best/worst heroes. The per-match rows are aggregated " +
      "SERVER-SIDE into a compact report (~3 KB) so neither API quota nor context window explodes. " +
      "Use this for 'analyze my last N games' questions — NEVER loop get_match over a match list; " +
      "pick specific match_ids from this report for deep dives instead. offset paginates backward through " +
      "history (SQL-style limit/offset over the window) — 'the 100 games before that' is offset=100.",
    schema: {
      account_id: accountId,
      limit: z.number().int().min(10).max(500).optional().describe("Max matches to analyze (default 100, hard cap 500)."),
      offset: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe("Skip the N most recent matches (after from/to filtering) before aggregating — SQL-style pagination through history, e.g. offset=100 limit=100 analyzes games 101-200."),
      from: z.string().optional().describe("Window start, 'YYYY-MM-DD' or ISO (inclusive). e.g. this month, this year."),
      to: z.string().optional().describe("Window end, 'YYYY-MM-DD' or ISO (inclusive; default now)."),
      language: languageParam,
      per_match: z.boolean().optional().describe("Include the full slim per-match list (default: only the 10 most recent)."),
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const limit = args.limit ?? 100;
      // One paged list fetch (endpoint accepts limit directly up to ~100;
      // page beyond that).
      // OpenDota's date filter is not honored by this endpoint (verified), so
      // windows are applied client-side while paging newest-first — pages are
      // only fetched until the window's start is crossed.
      let dateError: string | undefined;
      const parseDate = (v: string | undefined, label: string): number | undefined => {
        if (v == null) return undefined;
        const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
        if (Number.isNaN(t)) {
          dateError = `Invalid ${label} date: ${v} — use YYYY-MM-DD or ISO (e.g. from: "2026-08-01").`;
          return undefined;
        }
        return Math.floor(t / 1000);
      };
      const fromTs = parseDate(args.from, "from");
      const toTsRaw = parseDate(args.to, "to");
      if (dateError) return { error: dateError };
      const toTs = toTsRaw == null ? undefined : toTsRaw + 86400; // inclusive end of day
      const nowTs = Math.floor(Date.now() / 1000);
      const windowEnd = Math.min(toTs ?? nowTs + 60, nowTs + 60);
      const skip = args.offset ?? 0;
      if (skip + limit > 2000) {
        return { error: "offset + limit exceeds 2000 — deeper history slices are impractical against OpenDota paging." };
      }
      const rows: Record<string, any>[] = [];
      let matchedBeforeSkip = 0;
      let skipped = 0;
      let exhaustedHistory = false;
      const pageCap = Math.ceil((skip + limit) / 100) + 2;
      for (let pageIdx = 0; pageIdx < pageCap; pageIdx++) {
        const page = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/matches`, {
          query: { limit: 100, offset: pageIdx * 100, significant: 0 },
          ttl: "listing",
        });
        if (!Array.isArray(page) || page.length === 0) {
          exhaustedHistory = true;
          break;
        }
        const oldest = page[page.length - 1].start_time as number;
        for (const m of page) {
          if ((m.start_time as number) > windowEnd) continue;
          if (fromTs != null && (m.start_time as number) < fromTs) continue;
          matchedBeforeSkip++;
          if (skipped < skip) {
            skipped++;
            continue;
          }
          rows.push(m);
        }
        if (rows.length >= limit) break;
        if (fromTs != null && oldest < fromTs) {
          exhaustedHistory = true;
          break;
        }
        if (page.length < 100) {
          exhaustedHistory = true;
          break;
        }
      }
      if (rows.length === 0 && matchedBeforeSkip > 0) {
        return {
          error: `offset=${skip} skips past every match in the requested window (${matchedBeforeSkip} matched).`,
          hint: "Lower offset, or widen from/to.",
        };
      }
      if (rows.length > limit) rows.length = limit;
      const windowComplete = exhaustedHistory;
      if (rows.length === 0) {
        return { error: "No matches found for this player.", hint: "Check the account id; refresh_player can force an index update." };
      }
      // Oldest→newest for streak/trend math.
      const asc = [...rows].sort((a, b) => a.start_time - b.start_time);
      const pct1 = (w: number, g: number) => (g > 0 ? Math.round((w / g) * 1000) / 10 : undefined);
      const kda = (k: number, d: number, a: number) => (k + a) / Math.max(d, 1);

      let wins = 0;
      const heroAgg = new Map<number, { g: number; w: number; k: number; d: number; a: number }>();
      const modeAgg = new Map<number, { g: number; w: number }>();
      const partyAgg = new Map<string, { g: number; w: number }>();
      let durSum = 0;
      let leaves = 0;
      let kSum = 0;
      let dSum = 0;
      let aSum = 0;
      let curStreak = 0;
      let curStreakWin = false;
      let bestW = 0;
      let bestL = 0;
      let runW = 0;
      let runL = 0;
      for (const m of asc) {
        const win = m.radiant_win === ((m.player_slot ?? 0) < 128);
        if (win) {
          wins++;
          runW++;
          runL = 0;
          bestW = Math.max(bestW, runW);
        } else {
          runL++;
          runW = 0;
          bestL = Math.max(bestL, runL);
        }
        if (curStreak === 0) {
          curStreak = 1;
          curStreakWin = win;
        } else if (curStreakWin === win) {
          curStreak++;
        } else {
          curStreak = 1;
          curStreakWin = win;
        }
        const h = heroAgg.get(m.hero_id) ?? { g: 0, w: 0, k: 0, d: 0, a: 0 };
        h.g++;
        if (win) h.w++;
        h.k += m.kills ?? 0;
        h.d += m.deaths ?? 0;
        h.a += m.assists ?? 0;
        heroAgg.set(m.hero_id, h);
        const mo = modeAgg.get(m.game_mode) ?? { g: 0, w: 0 };
        mo.g++;
        if (win) mo.w++;
        modeAgg.set(m.game_mode, mo);
        const ps = m.party_size == null ? "unknown" : m.party_size === 1 ? "solo" : `${m.party_size}-stack`;
        const pa = partyAgg.get(ps) ?? { g: 0, w: 0 };
        pa.g++;
        if (win) pa.w++;
        partyAgg.set(ps, pa);
        durSum += m.duration ?? 0;
        if ((m.leaver_status ?? 0) > 1) leaves++;
        kSum += m.kills ?? 0;
        dSum += m.deaths ?? 0;
        aSum += m.assists ?? 0;
      }
      const n = asc.length;
      const half = Math.floor(n / 2);
      const firstHalfWins = asc.slice(0, half).filter((m) => m.radiant_win === ((m.player_slot ?? 0) < 128)).length;
      const secondHalfWins = wins - firstHalfWins;

      // Sessions: gaps > 4h split play sessions (timezone-free pattern signal).
      let sessions = n > 0 ? 1 : 0;
      for (let i = 1; i < n; i++) {
        if (asc[i].start_time - asc[i - 1].start_time > 4 * 3600) sessions++;
      }

      const byHero = await Promise.all(
        [...heroAgg.entries()]
          .sort((x, y) => y[1].g - x[1].g)
          .slice(0, 10)
          .map(async ([heroId, h]) => ({
            hero: (await heroRef(heroId, lang))?.name ?? `hero ${heroId}`,
            games: h.g,
            win_rate_pct: pct1(h.w, h.g),
            avg_kda: Math.round(((h.k + h.a) / Math.max(h.d, 1)) * 100) / 100,
          })),
      );
      const eligible = [...heroAgg.entries()].filter(([, h]) => h.g >= 3);
      const bestEntry = eligible.sort((x, y) => (pct1(y[1].w, y[1].g) ?? 0) - (pct1(x[1].w, x[1].g) ?? 0))[0];
      const worstEntry = [...eligible].sort((x, y) => (pct1(x[1].w, x[1].g) ?? 99) - (pct1(y[1].w, y[1].g) ?? 99))[0];
      const nm = async (e: typeof bestEntry) =>
        e ? { hero: (await heroRef(e[0], lang))?.name, games: e[1].g, win_rate_pct: pct1(e[1].w, e[1].g) } : undefined;

      const slim = (m: Record<string, any>) => {
        const win = m.radiant_win === ((m.player_slot ?? 0) < 128);
        return {
          match_id: m.match_id,
          hero: undefined as string | undefined, // filled below (async name lookup)
          result: win ? "W" : "L",
          kda: `${m.kills ?? 0}/${m.deaths ?? 0}/${m.assists ?? 0}`,
          minutes: Math.round((m.duration ?? 0) / 60),
        };
      };
      const slimRows = await Promise.all(
        (args.per_match ? asc : asc.slice(-10)).map(async (m) => ({
          ...slim(m),
          hero: (await heroRef(m.hero_id as number, lang))?.name,
        })),
      );

      return {
        account_id: args.account_id,
        window: {
          requested: args.from || args.to ? { from: args.from, to: args.to } : undefined,
          offset_applied: skip || undefined,
          coverage: windowComplete ? "complete" : "partial (capped at limit; oldest games in the window were not analyzed — raise limit or narrow from/to)",
          games: n,
          from: formatTimestamp(asc[0].start_time),
          to: formatTimestamp(asc[n - 1].start_time),
          days_spanned: Math.round((asc[n - 1].start_time - asc[0].start_time) / 86400),
          play_sessions: sessions,
          avg_matches_per_session: sessions > 0 ? Math.round((n / sessions) * 10) / 10 : undefined,
        },
        overall: {
          wins,
          losses: n - wins,
          win_rate_pct: pct1(wins, n),
          avg_kda: Math.round(((kSum + aSum) / Math.max(dSum, 1)) * 100) / 100,
          avg_duration_min: Math.round(durSum / n / 60),
          current_streak: `${curStreak}${curStreakWin ? "W" : "L"}`,
          longest_win_streak: bestW,
          longest_loss_streak: bestL,
          abandoned: leaves,
        },
        trend: {
          first_half_win_rate_pct: pct1(firstHalfWins, half),
          second_half_win_rate_pct: pct1(secondHalfWins, n - half),
          note: "halves are chronological — compare to spot rising or declining form.",
        },
        by_hero: byHero,
        best_hero: await nm(bestEntry),
        worst_hero: await nm(worstEntry),
        by_mode: await Promise.all(
          [...modeAgg.entries()]
            .sort((x, y) => y[1].g - x[1].g)
            .map(async ([modeId, mo]) => ({
              mode: (await gameModeName(modeId)) ?? `mode ${modeId}`,
              games: mo.g,
              win_rate_pct: pct1(mo.w, mo.g),
            })),
        ),
        by_party: [...partyAgg.entries()]
          .sort((x, y) => y[1].g - x[1].g)
          .map(([ps, pa]) => ({ party: ps, games: pa.g, win_rate_pct: pct1(pa.w, pa.g) })),
        recent_matches: slimRows,
        note:
          "Aggregated from OpenDota's match-list index (one request) — per-match replay detail is deliberately " +
          "excluded to protect quota and context. Pick match_ids from recent_matches for get_match / " +
          "get_match_coaching deep dives. Index lags hours for Turbo; totals here may undercount very recent games. " +
          "For WHOLE-CAREER aggregates (multi-year) use get_player_overview / get_player_heroes instead — they " +
          "aggregate over full history server-side.",
      };
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
        ttl: "player",
      });
      const lang = effectiveLanguage(args.language, ctx);
      return Promise.all(
        rows.map(async (row) => {
          const hero = await heroRef(row.hero_id, lang);
          const games = (row.games ?? 0) as number;
          const win = (row.win ?? 0) as number;
          const pct1 = (w: number, g: number) => (g > 0 ? Math.round((w / g) * 1000) / 10 : undefined);
          const withGames = (row.with_games ?? 0) as number;
          const againstGames = (row.against_games ?? 0) as number;
          return {
            ...row,
            hero,
            win_rate_pct: pct1(win, games),
            with_win_rate_pct: pct1((row.with_win ?? 0) as number, withGames),
            against_win_rate_pct: pct1((row.against_win ?? 0) as number, againstGames),
            last_played: row.last_played != null ? formatTimestamp(row.last_played as number) : undefined,
          };
        }),
      );
    },
  },
  {
    name: "get_player_peers",
    description:
      "People this player plays with most (party/duo partners): games together, win rate as a duo, and " +
      "per-game averages while together (GPM/XPM from the peer sums) — the 'how do we actually perform as a " +
      "stack' view. Follow up on any peer with get_player(account_id) or get_player_matches(included_account_id=...) " +
      "for hero-level detail.",
    schema: {
      account_id: accountId,
      limit: playerFilterShape.limit,
    },
    handler: async (args) => {
      // The peers endpoint ignores/mangles a limit param — page locally.
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/peers`, { ttl: "player" });
      return (rows ?? []).slice(0, args.limit ?? 15).map((row) => {
        const games = (row.games ?? 0) as number;
        const withGames = (row.with_games ?? 0) as number;
        const withWins = (row.with_win ?? 0) as number;
        return {
          account_id: row.account_id,
          personaname: row.personaname ?? row.name,
          last_played_together: formatTimestamp(row.last_played),
          games,
          wins: row.win,
          win_rate_pct: games > 0 ? Math.round((row.win / games) * 1000) / 10 : undefined,
          as_duo: {
            games: withGames,
            wins: withWins,
            win_rate_pct: withGames > 0 ? Math.round((withWins / withGames) * 1000) / 10 : undefined,
            ...(withGames > 0 && row.with_gpm_sum != null
              ? {
                  avg_gpm_while_together: Math.round((row.with_gpm_sum / withGames) * 10) / 10,
                  avg_xpm_while_together: Math.round((row.with_xpm_sum / withGames) * 10) / 10,
                }
              : {}),
          },
          against_games: row.against_games,
        };
      });
    },
  },
  {
    name: "get_player_opponents",
    description:
      "People this player keeps getting MATCHED AGAINST: scans the player's recent match list and fetches each " +
      "match to build an opponent ledger — who appears on the enemy side most, their rank, their favorite heroes " +
      "vs this player, and this player's win rate against them. Answers 'who keeps queueing into me and do I beat " +
      "them?'. COSTS one request per scanned match (default 30, results disk-cached ~10 min) — use for one player " +
      "at a time, not in bulk.",
    schema: {
      account_id: accountId,
      limit_matches: z.number().int().min(10).max(60).optional().describe("Recent matches to scan (default 30)."),
      min_encounters: z.number().int().min(1).max(20).optional().describe("Min times someone must appear on the enemy side (default 2)."),
      significant: z
        .number()
        .int()
        .min(0)
        .max(1)
        .optional()
        .describe("1 = ranked/standard modes only (recommended for 'who do I keep queueing into'); omit for all modes."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const history = await apiGet<{ match_id: number }[]>(`/players/${args.account_id}/matches`, {
        query: { limit: args.limit_matches ?? 30, significant: args.significant },
        ttl: "default",
      });
      const matches = (
        await Promise.all(
          (history ?? []).slice(0, args.limit_matches ?? 30).map((h) =>
            apiGet<Record<string, any>>(`/matches/${h.match_id}`, { ttl: "match", timeoutMs: 20_000 }).catch(() => null),
          ),
        )
      ).filter(Boolean) as Record<string, any>[];
      interface OppAgg {
        name?: string;
        rankTier?: number;
        games: number;
        myWins: number;
        lastTime?: number;
        heroes: Map<number, { games: number; myWins: number }>;
      }
      const opponents = new Map<number, OppAgg>();
      for (const m of matches) {
        const players: Record<string, any>[] = m.players ?? [];
        const me = players.find((p) => p.account_id === args.account_id);
        if (!me || m.radiant_win == null) continue;
        const myRadiant = me.player_slot < 128;
        const myWin = m.radiant_win === myRadiant;
        for (const p of players) {
          if (p.account_id == null || p.account_id === args.account_id) continue;
          const sameSide = (p.player_slot < 128) === myRadiant;
          if (sameSide) continue;
          const agg: OppAgg = opponents.get(p.account_id) ?? { games: 0, myWins: 0, lastTime: 0, heroes: new Map() };
          agg.games += 1;
          if (myWin) agg.myWins += 1;
          if (p.personaname) agg.name = p.personaname;
          if (p.rank_tier != null) agg.rankTier = p.rank_tier;
          agg.lastTime = Math.max(agg.lastTime ?? 0, m.start_time ?? 0);
          if (p.hero_id != null) {
            const h = agg.heroes.get(p.hero_id) ?? { games: 0, myWins: 0 };
            h.games += 1;
            if (myWin) h.myWins += 1;
            agg.heroes.set(p.hero_id, h);
          }
          opponents.set(p.account_id, agg);
        }
      }
      const rows = await Promise.all(
        [...opponents.entries()]
          .filter(([, a]) => a.games >= (args.min_encounters ?? 2))
          .sort((a, b) => b[1].games - a[1].games)
          .slice(0, 15)
          .map(async ([id, a]) => {
            const heroes = await Promise.all(
              [...a.heroes.entries()]
                .sort((x, y) => y[1].games - x[1].games)
                .slice(0, 3)
                .map(async ([heroId, h]) => ({
                  hero: (await heroRef(heroId, lang))?.name ?? `hero ${heroId}`,
                  games: h.games,
                  my_win_rate_pct: Math.round((h.myWins / h.games) * 1000) / 10,
                })),
            );
            return {
              player: a.name ?? `account ${id}`,
              account_id: id,
              ...(a.rankTier != null ? { rank_tier: rankTierToLabel(a.rankTier, undefined, lang), rank_tier_raw: a.rankTier } : {}),
              encounters: a.games,
              my_win_rate_pct: Math.round((a.myWins / a.games) * 1000) / 10,
              ...sampleFields(a.games, a.myWins),
              their_heroes_vs_me: heroes,
              last_encounter: a.lastTime ? formatTimestamp(a.lastTime) : undefined,
            };
          }),
      );
      const times = matches.map((m) => m.start_time).filter(Boolean);
      return {
        account_id: args.account_id,
        matches_scanned: matches.length,
        ...(times.length ? { scanned_range: `${formatTimestamp(Math.min(...times))} → ${formatTimestamp(Math.max(...times))}` } : {}),
        repeat_opponents: rows,
        note: "Encounters are counted within the scanned window only. my_win_rate_pct is the scanned player's win rate against that opponent. For teammate analysis use get_player_peers.",
      };
    },
  },
  {
    name: "get_player_partnership",
    description:
      "How one player and one specific friend ACTUALLY perform together: games on the same side vs against " +
      "each other, win rates both ways, each side's most-played heroes in those games with win rates (who " +
      "picks what when partied), and when they last played together. Built by scanning their shared match " +
      "history (uses included_account_id, then one request per shared match — cheap for duos, results cached). " +
      "Start from get_player_peers for the friend list, then drill in with this.",
    schema: {
      account_id: accountId,
      peer_account_id: z.number().int().positive().describe("The friend's account id (from get_player_peers)."),
      limit_matches: z.number().int().min(5).max(60).optional().describe("Shared matches to scan (default 30)."),
      min_hero_games: z.number().int().min(1).max(10).optional().describe("Min games for a hero row (default 2)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const history = await apiGet<{ match_id: number }[]>(`/players/${args.account_id}/matches`, {
        query: { included_account_id: args.peer_account_id, limit: args.limit_matches ?? 30 },
        ttl: "default",
      });
      const matches = (
        await Promise.all(
          (history ?? []).slice(0, args.limit_matches ?? 30).map((h) =>
            apiGet<Record<string, any>>(`/matches/${h.match_id}`, { ttl: "match", timeoutMs: 20_000 }).catch(() => null),
          ),
        )
      ).filter(Boolean) as Record<string, any>[];

      interface SideAgg {
        games: number;
        wins: number;
        lastTime?: number;
        myHeroes: Map<number, { games: number; wins: number }>;
        theirHeroes: Map<number, { games: number; wins: number }>;
      }
      const emptyAgg = (): SideAgg => ({ games: 0, wins: 0, myHeroes: new Map(), theirHeroes: new Map() });
      const together = emptyAgg();
      const against = emptyAgg();
      let peerName: string | undefined;

      for (const m of matches) {
        const players: Record<string, any>[] = m.players ?? [];
        const me = players.find((p) => p.account_id === args.account_id);
        const peer = players.find((p) => p.account_id === args.peer_account_id);
        if (!me || !peer || m.radiant_win == null) continue;
        if (peer.personaname) peerName = peer.personaname;
        const sameSide = (me.player_slot < 128) === (peer.player_slot < 128);
        const myWin = m.radiant_win === (me.player_slot < 128);
        const agg = sameSide ? together : against;
        agg.games += 1;
        if (myWin) agg.wins += 1;
        agg.lastTime = Math.max(agg.lastTime ?? 0, m.start_time ?? 0);
        const mh = agg.myHeroes.get(me.hero_id) ?? { games: 0, wins: 0 };
        mh.games += 1;
        if (myWin) mh.wins += 1;
        agg.myHeroes.set(me.hero_id, mh);
        const th = agg.theirHeroes.get(peer.hero_id) ?? { games: 0, wins: 0 };
        th.games += 1;
        if (myWin) th.wins += 1;
        agg.theirHeroes.set(peer.hero_id, th);
      }

      const minHeroGames = args.min_hero_games ?? 2;
      const heroRows = async (agg: SideAgg, whose: "my" | "their") => {
        const map = whose === "my" ? agg.myHeroes : agg.theirHeroes;
        return Promise.all(
          [...map.entries()]
            .filter(([, h]) => h.games >= minHeroGames)
            .sort((a, b) => b[1].games - a[1].games)
            .slice(0, 5)
            .map(async ([heroId, h]) => ({
              hero: (await heroRef(heroId, lang))?.name ?? `hero ${heroId}`,
              games: h.games,
              win_rate_pct: Math.round((h.wins / h.games) * 1000) / 10,
            })),
        );
      };
      const sideCard = async (agg: SideAgg, label: string) => ({
        label,
        ...(agg.games > 0
          ? {
              games: agg.games,
              wins: agg.wins,
              win_rate_pct: Math.round((agg.wins / agg.games) * 1000) / 10,
              ...sampleFields(agg.games, agg.wins),
              ...(agg.lastTime ? { last_time: formatTimestamp(agg.lastTime) } : {}),
              my_heroes_when_together: await heroRows(agg, "my"),
              their_heroes: await heroRows(agg, "their"),
            }
          : { games: 0 }),
      });

      return {
        account_id: args.account_id,
        peer: peerName ?? `account ${args.peer_account_id}`,
        peer_account_id: args.peer_account_id,
        matches_scanned: matches.length,
        together: await sideCard(together, "same side (party)"),
        against_each_other: await sideCard(against, "opposite sides"),
        note: "Win rates are the scanned player's perspective. Hero rows list what each of you played in these shared games — a pairing's real win rate needs games (check low_sample). Turbo included.",
      };
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
        ttl: "player",
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
      return apiGet(`/players/${args.account_id}/totals`, { query: toQuery(filtersOf(args)), ttl: "player" });
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
        ttl: "player",
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
        leaver_status: await resolveKeys(counts.leaver_status, (id) => Promise.resolve(leaverStatusLabel(id))),
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
        ttl: "player",
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
        { query: toQuery(filtersOf(args)), ttl: "player" },
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
        { query: toQuery(filtersOf(args)), ttl: "player" },
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
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/ratings`, { ttl: "player" });
      return rows.map((row) => ({
        match_id: row.match_id,
        time: formatTimestamp(row.time),
        rank_tier: rankTierToLabel(row.rank_tier, undefined, lang),
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
      const rows = await apiGet<Record<string, any>[]>(`/players/${args.account_id}/rankings`, { ttl: "player" });
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

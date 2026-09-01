import { z } from "zod";
import { normalizeLanguage, type SupportedLanguage } from "../locales.js";

export interface ToolContext {
  /** Server-level default language (OPENDOTA_LANGUAGE or english). */
  defaultLanguage: SupportedLanguage;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
}

/** Shared optional language parameter offered on tools that resolve game-entity names. */
export const languageParam = z
  .string()
  .optional()
  .describe(
    'Language for hero/item/ability names. Accepts Steam codes ("english", "schinese", "russian", ...) or ' +
      'tags ("zh-CN", "zh", "ru", ...). Defaults to the OPENDOTA_LANGUAGE env var or "english". ' +
      "Use list_supported_languages to see all options.",
  );

/** Resolve the effective language for a call, falling back to the server default. */
export function effectiveLanguage(requested: string | undefined, ctx: ToolContext): SupportedLanguage {
  if (requested && requested.trim()) return normalizeLanguage(requested);
  return ctx.defaultLanguage;
}

/**
 * Standard OpenDota player-match filters, shared by most /players/{account_id}/* tools.
 * Values are passed straight through to the API.
 */
export const playerFilterShape = {
  limit: z.number().int().min(1).max(100).optional().describe("Max results to return."),
  offset: z.number().int().min(0).optional().describe("Skip this many results (pagination)."),
  win: z.number().int().min(0).max(1).optional().describe("1 = wins only, 0 = losses only."),
  patch: z.number().int().optional().describe("Patch id filter (e.g. from get_constants patch)."),
  game_mode: z.number().int().optional().describe("Game mode id filter (e.g. 22 = Ranked All Pick)."),
  lobby_type: z.number().int().optional().describe("Lobby type id filter (e.g. 7 = Ranked)."),
  region: z.number().int().optional().describe("Region id filter."),
  date: z.number().int().optional().describe("Only matches from the last N days."),
  lane_role: z.number().int().min(0).max(4).optional().describe("Lane role: 1=Safe, 2=Mid, 3=Off, 4=Jungle."),
  hero_id: z.number().int().optional().describe("Only matches on this hero id."),
  is_radiant: z.number().int().min(0).max(1).optional().describe("1 = Radiant side only, 0 = Dire only."),
  included_account_id: z.array(z.number().int()).optional().describe("Only matches where these account ids played."),
  excluded_account_id: z.array(z.number().int()).optional().describe("Exclude matches where these account ids played."),
  with_hero_id: z.array(z.number().int()).optional().describe("Only matches with these heroes on the player's team."),
  against_hero_id: z.array(z.number().int()).optional().describe("Only matches against these heroes."),
  significant: z
    .number()
    .int()
    .min(0)
    .max(1)
    .optional()
    .describe("1 (default) excludes non-standard modes; set 0 to include everything."),
  having: z.number().int().optional().describe("Min games played (used by hero-stat tools)."),
  sort: z.string().optional().describe("Sort results by this field, descending (e.g. 'start_time')."),
} as const satisfies z.ZodRawShape;

/** Only the filters that make sense per endpoint; project is separate. */
export const playerFilterFields = Object.keys(playerFilterShape);

/** Convert filter args (already zod-parsed object) into an OpenDota query object. */
export function toQuery(args: Record<string, unknown>): Record<string, string | number | (string | number)[]> {
  const query: Record<string, string | number | (string | number)[]> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) query[k] = v as number[];
    else query[k] = v as string | number;
  }
  return query;
}

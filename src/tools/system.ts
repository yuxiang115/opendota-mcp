import { z } from "zod";
import { apiGet } from "../client.js";
import { getConstantResource } from "../constants.js";
import { getLocaleBundle, LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "../locales.js";
import { languageParam, effectiveLanguage, type ToolDef } from "./registry.js";

const ENTITY_KINDS = ["hero", "item", "ability"] as const;

export const systemTools: ToolDef[] = [
  {
    name: "get_api_health",
    description:
      "Check OpenDota API service health/statistics. Useful to verify connectivity before deeper queries.",
    schema: {},
    handler: async () => {
      // /health reports degraded state via HTTP 500 while the body is still valid status data.
      return apiGet("/health", { ttl: "listing", allowErrorStatus: true });
    },
  },
  {
    name: "list_supported_languages",
    description:
      "List the languages available for hero/item/ability name localization, with their Steam codes " +
      '(e.g. "schinese") and labels. Pass one of these to the language parameter of other tools.',
    schema: {},
    handler: async () => {
      return {
        languages: SUPPORTED_LANGUAGES.map((code) => ({ code, label: LANGUAGE_LABELS[code] ?? code })),
        usage: 'Pass code or common tag (e.g. "zh-CN") to the language parameter of any tool that returns names.',
      };
    },
  },
  {
    name: "get_constants",
    description:
      "Get a raw OpenDota game-constants resource (heroes, items, abilities, item_ids, ability_ids, game_mode, " +
      "lobby_type, region, patch, cluster, countries, ...). Note: OpenDota constants are English-only; " +
      "for localized names prefer tools with a language parameter.",
    schema: {
      resource: z
        .string()
        .describe(
          "Constant resource name, e.g. heroes, items, item_ids, abilities, ability_ids, game_mode, lobby_type, region, patch.",
        ),
    },
    handler: async (args) => {
      return getConstantResource(args.resource);
    },
  },
  {
    name: "search_dota_entities",
    description:
      "Find heroes/items/abilities by name (English or any supported localized name) and get their numeric ids. " +
      'Use this FIRST to resolve names like "敌法师", "Anti-Mage", "blink dagger", "祈求者" into the ids ' +
      "other tools need (hero_id, item ids, ...). Case-insensitive substring match.",
    schema: {
      query: z.string().describe("Name or partial name to search for (English or localized)."),
      kind: z.enum(ENTITY_KINDS).optional().describe("Restrict search to one entity kind. Omit to search all."),
      language: languageParam,
      limit: z.number().int().min(1).max(50).optional().describe("Max results per kind (default 10)."),
    },
    handler: async (args, ctx) => {
      const q = args.query.trim().toLowerCase();
      if (!q) return { query: args.query, matches: [] };
      const cap = args.limit ?? 10;
      const lang = effectiveLanguage(args.language, ctx);
      const english = getLocaleBundle("english");
      // Search matches the English bundle AND the requested language's bundle, so both
      // "Anti-Mage" and "敌法师" resolve regardless of the configured default.
      const localized = getLocaleBundle(lang);
      const results: Record<string, unknown>[] = [];
      const searchTable = (table: "heroes" | "items" | "abilities", kind: (typeof ENTITY_KINDS)[number]) => {
        if (args.kind && args.kind !== kind) return;
        const en = english[table];
        const loc = localized[table];
        let count = 0;
        for (const [id, entry] of Object.entries(en)) {
          if (count >= cap) break;
          const localName = loc[id]?.name ?? "";
          const haystacks = [entry.name, entry.name_en, entry.internal, localName].map((s) => s.toLowerCase());
          if (!haystacks.some((h) => h.includes(q))) continue;
          results.push({
            kind,
            id: Number(id),
            name: localName || entry.name,
            name_en: entry.name_en,
            internal: entry.internal,
          });
          count++;
        }
      };
      searchTable("heroes", "hero");
      searchTable("items", "item");
      searchTable("abilities", "ability");
      return { query: args.query, matches: results };
    },
  },
];

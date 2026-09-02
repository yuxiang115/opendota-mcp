import { z } from "zod";
import { apiGet } from "../client.js";
import { CONSTANTS_RESOURCES, getConstantResource, getItemIds } from "../constants.js";
import { getAliasTables, internalHeroToId, lookupHeroAlias, lookupItemAlias } from "../aliases.js";
import { getLocaleBundle, LANGUAGE_LABELS, listBundledLanguages, SUPPORTED_LANGUAGES } from "../locales.js";
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
      "Get a raw OpenDota game-constants resource. These mirror the dotaconstants package files: " +
      `${CONSTANTS_RESOURCES.join(", ")}. ` +
      "Note: constants are English-only; for localized hero/item/ability names prefer tools with a language parameter.",
    schema: {
      resource: z.string().describe(`One of: ${CONSTANTS_RESOURCES.join(", ")}.`),
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

      // An EXACT ambiguous nickname (猴子/ES/BM) beats any substring fuzz — the
      // substring scan would otherwise return unrelated abilities like 猴子猴孙.
      const ambTargets = getAliasTables().ambiguous[q];
      if (ambTargets) {
        const candidates = ambTargets
          .map((internal) => {
            const id = internalHeroToId(internal);
            if (id == null) return undefined;
            const en = english.heroes[String(id)];
            return {
              kind: "hero",
              id,
              name: localized.heroes[String(id)]?.name || en?.name,
              name_en: en?.name_en,
            };
          })
          .filter((c) => c != null);
        return {
          query: args.query,
          ambiguous: {
            alias: args.query,
            candidates,
            ask_user: "This nickname means different heroes — ask the user which one they mean.",
          },
          matches: [],
        };
      }

      const results: Record<string, unknown>[] = [];
      const searchBundle = (bundle: ReturnType<typeof getLocaleBundle>) => {
        const searchTable = (table: "heroes" | "items" | "abilities", kind: (typeof ENTITY_KINDS)[number]) => {
          if (args.kind && args.kind !== kind) return;
          const en = english[table];
          const loc = bundle[table];
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
      };
      searchBundle(localized);
      // If the query was in another language (e.g. Chinese typed with an English default),
      // fall back to scanning every bundled language before giving up.
      if (results.length === 0) {
        for (const code of listBundledLanguages()) {
          if (code === "english") continue;
          searchBundle(getLocaleBundle(code));
          if (results.length > 0) break;
        }
      }
      // Community nicknames (火猫, 大骨灰, ...) exist in no official table. An exact
      // nickname hit outranks substring fuzz, so it is prepended, not just used as fallback.
      const heroAlias = lookupHeroAlias(args.query);
      if (heroAlias && "id" in heroAlias) {
        const en = english.heroes[String(heroAlias.id)];
        results.unshift({
          kind: "hero",
          id: heroAlias.id,
          name: localized.heroes[String(heroAlias.id)]?.name || en?.name || heroAlias.internal,
          name_en: en?.name_en,
          internal: heroAlias.internal,
          via: "nickname",
        });
      } else if (results.length === 0) {
        const itemInternal = lookupItemAlias(args.query);
        if (itemInternal) {
          const ids = await getItemIds();
          const id = Object.entries(ids).find(([, internal]) => String(internal) === itemInternal)?.[0];
          if (id != null) {
            const en = english.items[id];
            results.push({
              kind: "item",
              id: Number(id),
              name: localized.items[id]?.name || en?.name || itemInternal,
              name_en: en?.name_en,
              internal: itemInternal,
              via: "nickname",
            });
          }
        }
      }
      return { query: args.query, matches: results };
    },
  },
];

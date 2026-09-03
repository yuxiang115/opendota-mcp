import { z } from "zod";
import { apiGet } from "../client.js";
import { heroLookupError, lookupHeroAlias } from "../aliases.js";
import {
  getItemIds,
  getAbilities,
  getHeroAbilities,
  getItems,
  type HeroFacet,
} from "../constants.js";
import { getLocaleBundle } from "../locales.js";
import { heroRef, itemRef, type NameRef } from "../mapping.js";
import { effectiveLanguage, languageParam, type ToolDef } from "./registry.js";

interface AbilityDetail {
  internal: string;
  name: string;
  name_en: string;
  description?: string;
  mana_cost?: string;
  cooldown?: string;
  damage_type?: string;
  behavior?: string;
  dispellable?: string;
  attributes?: { label: string; value: unknown }[];
  aghanims_scepter_upgrade?: boolean;
  aghanims_shard_upgrade?: boolean;
}

interface ItemAbilityEffect {
  type?: string;
  title?: string;
  description?: string;
}

/** Valve loc strings carry unfilled placeholders like "+{s:bonus}% Damage"; strip the whole chunk. */
export function stripPlaceholders(s: string): string {
  return s
    .replace(/\s*[/+-]?\s*\{[sd]:[^}]*\}\s*[sd%]?/g, " ")
    .replace(/\{value\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toAbilityDetail(internal: string, raw: Record<string, any>, lang: string): AbilityDetail {
  const local = getLocaleBundle(lang).abilities;
  const english = getLocaleBundle("english").abilities;
  const detail: AbilityDetail = {
    internal,
    name: raw.dname ?? internal,
    name_en: raw.dname ?? internal,
  };
  // Localized display names come from the Valve locale tables (keyed by ability id,
  // so reverse-lookup); fall back to the constants' English dname.
  const localEntry = Object.values(local).find((e) => e.internal === internal && e.name);
  if (localEntry) detail.name = localEntry.name;
  void english;
  if (raw.desc) detail.description = String(raw.desc);
  if (raw.mc) detail.mana_cost = String(raw.mc);
  if (raw.cd) detail.cooldown = String(raw.cd);
  if (raw.dmg_type) detail.damage_type = raw.dmg_type;
  if (raw.behavior) detail.behavior = raw.behavior;
  if (raw.dispellable && raw.dispellable !== "No") detail.dispellable = raw.dispellable;
  if (Array.isArray(raw.attrib) && raw.attrib.length > 0) {
    detail.attributes = raw.attrib.map((a: Record<string, any>) => ({
      label: stripPlaceholders(String(a.header ?? a.key ?? "")),
      value: a.value,
    }));
  }
  if (raw.aghanims_scepter === 1) detail.aghanims_scepter_upgrade = true;
  if (raw.aghanims_shard === 1) detail.aghanims_shard_upgrade = true;
  return detail;
}

/** Resolve a hero by numeric id OR by exact/unique name (English or localized). */
export async function resolveHero(input: number | string, lang: string): Promise<number | undefined> {
  if (typeof input === "number") return input;
  const q = input.trim().toLowerCase();
  const english = getLocaleBundle("english").heroes;
  const local = getLocaleBundle(lang).heroes;
  for (const [id, entry] of Object.entries(english)) {
    if (
      entry.name_en.toLowerCase() === q ||
      entry.name.toLowerCase() === q ||
      entry.internal.toLowerCase() === q
    ) {
      return Number(id);
    }
  }
  for (const [id, entry] of Object.entries(local)) {
    if (entry.name.toLowerCase() === q) return Number(id);
  }
  // Community nicknames (火猫, 白牛, PA, ...) — ambiguous ones intentionally do not resolve.
  const alias = lookupHeroAlias(input);
  if (alias && "id" in alias) return alias.id;
  // Unique substring match as a last resort.
  const partial = Object.entries(english).filter(
    ([, e]) => e.name_en.toLowerCase().includes(q) || e.internal.includes(q),
  );
  return partial.length === 1 ? Number(partial[0][0]) : undefined;
}

const heroInput = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Hero id, or hero name (English/localized, e.g. 1, 'Anti-Mage', '敌法师').");

export const referenceTools: ToolDef[] = [
  {
    name: "get_hero_kit",
    description:
      "Full ability reference for a hero: every ability with localized name, English description, " +
      "mana cost, cooldown, damage type, per-level numbers, Aghanim's scepter/shard upgrade flags, " +
      "plus all 10 talents (with descriptions) and non-deprecated facets. Use this instead of guessing " +
      "what an unfamiliar/newer hero's abilities do — descriptions are in English (Valve/OpenDota " +
      "constants are English-only), names are localized.",
    schema: {
      hero: heroInput,
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const heroId = await resolveHero(args.hero, lang);
      if (heroId == null) {
        return heroLookupError(args.hero, lang);
      }
      const hero = await heroRef(heroId, lang);
      const internalHero = getLocaleBundle("english").heroes[String(heroId)]?.internal ?? "";
      const kit = (await getHeroAbilities())[internalHero];
      if (!kit) {
        return {
          error: `No ability data for hero ${args.hero}`,
          hint: "Verify the hero id with search_dota_entities / get_heroes first.",
        };
      }

      const abilitiesTable = await getAbilities();
      const abilities: AbilityDetail[] = (kit.abilities ?? [])
        .filter((a) => abilitiesTable[a])
        .map((a) => toAbilityDetail(a, abilitiesTable[a] as Record<string, any>, lang));

      const talents = (kit.talents ?? [])
        .map((t) => ({ level: t.level, raw: abilitiesTable[t.name] }))
        .filter((t) => t.raw)
        .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
        .map((t) => ({
          level: t.level,
          name: stripPlaceholders(String(t.raw.dname ?? t.raw.name ?? "")),
          description: t.raw.desc ? String(t.raw.desc) : undefined,
        }));

      const facets = (kit.facets ?? [])
        .filter((f: HeroFacet) => f.deprecated !== "1")
        .map((f: HeroFacet) => ({
          id: f.id,
          title: f.title ?? f.name,
          description: f.description,
        }));

      return { hero, abilities, talents, facets };
    },
  },
  {
    name: "get_item_details",
    description:
      "Detailed item reference for up to 10 items (by item id or English/localized name, e.g. " +
      "'bfury', '闪烁匕首', 145): cost, shop quality, active/passive effect descriptions, " +
      "stat attributes, cooldown/mana cost, component list and lore. Descriptions are English " +
      "(OpenDota constants are English-only); names are localized. Use this instead of guessing " +
      "what an item does or what it costs.",
    schema: {
      items: z
        .array(z.union([z.number().int(), z.string().min(1)]))
        .min(1)
        .max(10)
        .describe("Item ids or names (English/localized/internal)."),
      language: languageParam,
    },
    handler: async (args, ctx) => {
      const lang = effectiveLanguage(args.language, ctx);
      const itemsTable = await getItems();
      const englishNames = getLocaleBundle("english").items;

      // Name -> id index (english display, localized display, internal, with/without item_ prefix).
      const byName = new Map<string, number>();
      for (const [id, entry] of Object.entries(englishNames)) {
        byName.set(entry.name_en.toLowerCase(), Number(id));
        byName.set(entry.name_en.toLowerCase().replace(/\s+/g, ""), Number(id));
      }
      for (const [id, entry] of Object.entries(getLocaleBundle(lang).items)) {
        byName.set(entry.name.toLowerCase(), Number(id));
      }

      const results: unknown[] = [];
      for (const input of args.items) {
        let itemId: number | undefined = typeof input === "number" ? input : undefined;
        let internalKey: string | undefined;
        if (itemId == null && typeof input === "string") {
          const q = input.trim().toLowerCase();
          itemId = byName.get(q) ?? byName.get(q.replace(/\s+/g, ""));
          if (itemId == null) {
            // Internal-name direct lookup (works with and without the item_ prefix).
            internalKey = itemsTable[q] ? q : itemsTable[`item_${q}`] ? `item_${q}` : q.replace(/^item_/, "");
          }
        }
        if (itemId != null) {
          const localeEntry = englishNames[String(itemId)];
          internalKey = localeEntry?.internal?.replace(/^item_/, "") ?? internalKey;
        }
        // Internal-name lookups leave itemId null, which silently killed name
        // localization below — backfill it from the id<->internal map.
        if (itemId == null && internalKey) {
          const byInternal = new Map(Object.entries(await getItemIds()).map(([id, internal]) => [String(internal), Number(id)]));
          itemId = byInternal.get(internalKey) ?? byInternal.get(`item_${internalKey}`) ?? undefined;
        }
        const raw = internalKey ? (itemsTable[internalKey] as Record<string, any> | undefined) : undefined;
        if (!raw) {
          results.push({ query: input, error: "not found", hint: "Try search_dota_entities for the exact name." });
          continue;
        }
        const ref: NameRef | undefined = itemId != null ? await itemRef(itemId, lang) : undefined;
        results.push({
          name: ref?.name ?? raw.dname,
          name_en: ref?.name_en ?? raw.dname,
          internal: internalKey,
          id: raw.id ?? itemId,
          cost: raw.cost,
          quality: raw.qual,
          effects: (raw.abilities as ItemAbilityEffect[] | undefined)?.map((e) => ({
            type: e.type,
            title: e.title,
            description: e.description,
          })),
          stats: Array.isArray(raw.attrib)
            ? raw.attrib.map((a: Record<string, any>) => ({
                label: stripPlaceholders(String(a.display ?? a.header ?? a.key ?? "")),
                value: a.value,
              }))
            : undefined,
          cooldown: raw.cd !== false ? raw.cd : undefined,
          mana_cost: raw.mc !== false ? raw.mc : undefined,
          components: raw.components,
          lore: raw.lore,
        });
      }
      return { items: results };
    },
  },
];

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { LOCALES_DIR } from "./config.js";

/**
 * Steam language codes bundled under locales/.
 * Data source: Valve's official dota2.com datafeed (herolist/itemlist/abilitylist?language=xx).
 */
export const SUPPORTED_LANGUAGES = [
  "english",
  "schinese",
  "tchinese",
  "japanese",
  "koreana",
  "russian",
  "spanish",
  "latam",
  "brazilian",
  "portuguese",
  "french",
  "german",
  "italian",
  "turkish",
  "polish",
  "czech",
  "danish",
  "dutch",
  "finnish",
  "greek",
  "hungarian",
  "norwegian",
  "romanian",
  "swedish",
  "thai",
  "vietnamese",
  "ukrainian",
  "bulgarian",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Human-friendly display labels for each language code. */
export const LANGUAGE_LABELS: Record<string, string> = {
  english: "English",
  schinese: "简体中文 (Simplified Chinese)",
  tchinese: "繁體中文 (Traditional Chinese)",
  japanese: "日本語 (Japanese)",
  koreana: "한국어 (Korean)",
  russian: "Русский (Russian)",
  spanish: "Español (Spanish)",
  latam: "Español Latinoamericano (Latin American Spanish)",
  brazilian: "Português do Brasil (Brazilian Portuguese)",
  portuguese: "Português (Portuguese)",
  french: "Français (French)",
  german: "Deutsch (German)",
  italian: "Italiano (Italian)",
  turkish: "Türkçe (Turkish)",
  polish: "Polski (Polish)",
  czech: "Čeština (Czech)",
  danish: "Dansk (Danish)",
  dutch: "Nederlands (Dutch)",
  finnish: "Suomi (Finnish)",
  greek: "Ελληνικά (Greek)",
  hungarian: "Magyar (Hungarian)",
  norwegian: "Norsk (Norwegian)",
  romanian: "Română (Romanian)",
  swedish: "Svenska (Swedish)",
  thai: "ไทย (Thai)",
  vietnamese: "Tiếng Việt (Vietnamese)",
  ukrainian: "Українська (Ukrainian)",
  bulgarian: "Български (Bulgarian)",
};

/** Aliases users/LLMs commonly type, normalized to Steam codes. */
const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  en: "english",
  "en-us": "english",
  "en-gb": "english",
  us: "english",
  zh: "schinese",
  "zh-cn": "schinese",
  "zh-hans": "schinese",
  cn: "schinese",
  "zh-tw": "tchinese",
  "zh-hant": "tchinese",
  tw: "tchinese",
  hk: "tchinese",
  ja: "japanese",
  "ja-jp": "japanese",
  jp: "japanese",
  ko: "koreana",
  "ko-kr": "koreana",
  kr: "koreana",
  ru: "russian",
  "ru-ru": "russian",
  es: "spanish",
  "es-es": "spanish",
  "es-419": "latam",
  mx: "latam",
  pt: "portuguese",
  "pt-br": "brazilian",
  br: "brazilian",
  "pt-pt": "portuguese",
  fr: "french",
  "fr-fr": "french",
  de: "german",
  "de-de": "german",
  it: "italian",
  "it-it": "italian",
  tr: "turkish",
  "tr-tr": "turkish",
  pl: "polish",
  "pl-pl": "polish",
  cs: "czech",
  "cs-cz": "czech",
  da: "danish",
  "da-dk": "danish",
  nl: "dutch",
  "nl-nl": "dutch",
  fi: "finnish",
  "fi-fi": "finnish",
  el: "greek",
  "el-gr": "greek",
  hu: "hungarian",
  "hu-hu": "hungarian",
  no: "norwegian",
  "nb-no": "norwegian",
  nb: "norwegian",
  ro: "romanian",
  "ro-ro": "romanian",
  sv: "swedish",
  "sv-se": "swedish",
  th: "thai",
  "th-th": "thai",
  vi: "vietnamese",
  "vi-vn": "vietnamese",
  uk: "ukrainian",
  "uk-ua": "ukrainian",
  bg: "bulgarian",
  "bg-bg": "bulgarian",
};

/** Normalize any user-provided language tag to a bundled Steam language code (defaults to english). */
export function normalizeLanguage(input?: string): SupportedLanguage {
  if (!input) return "english";
  const raw = input.trim().toLowerCase().replace(/_/g, "-");
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(raw)) {
    return raw as SupportedLanguage;
  }
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  // e.g. "schinese" typed with underscores, or "spanish (spain)"
  const base = raw.split(/[-(]/)[0];
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
    return base as SupportedLanguage;
  }
  if (LANGUAGE_ALIASES[base]) return LANGUAGE_ALIASES[base];
  return "english";
}

export interface LocalizedEntry {
  /** Localized display name. */
  name: string;
  /** English display name. */
  name_en: string;
  /** Internal dota name, e.g. npc_dota_hero_antimage / item_blink. */
  internal: string;
}

interface LocaleBundle {
  heroes: Record<string, LocalizedEntry>;
  items: Record<string, LocalizedEntry>;
  abilities: Record<string, LocalizedEntry>;
  /** Localized ability descriptions (Valve game files); absent for english
   *  (runtime falls back to OpenDota's English text) and any language whose
   *  file was unavailable at build time. */
  abilityDescriptions?: Record<string, string>;
}

const bundleCache = new Map<string, LocaleBundle>();

export function listBundledLanguages(): string[] {
  if (!existsSync(LOCALES_DIR)) return [];
  return readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function loadTable(lang: string, table: "heroes" | "items" | "abilities"): Record<string, LocalizedEntry> {
  const file = path.join(LOCALES_DIR, lang, `${table}.json`);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, LocalizedEntry>;
  } catch {
    return {};
  }
}

/** Get (and cache) the locale bundle for a language, falling back to english. */
const descCache = new Map<string, Record<string, string> | undefined>();

/** Localized ability descriptions for one language (Valve game files), loaded
 *  on demand — name-table consumers (search fallbacks across all languages)
 *  never pay the ~10x description cost. */
export function getAbilityDescriptions(lang: string): Record<string, string> | undefined {
  if (descCache.has(lang)) return descCache.get(lang);
  const v = loadDescTableOnce(lang);
  descCache.set(lang, v);
  return v;
}

function loadDescTableOnce(lang: string): Record<string, string> | undefined {
  try {
    const file = path.join(LOCALES_DIR, lang, "ability_descriptions.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return undefined;
  }
}

export function getLocaleBundle(lang: string): LocaleBundle {
  const bundled = new Set(listBundledLanguages());
  const target = bundled.has(lang) ? lang : "english";
  const cached = bundleCache.get(target);
  if (cached) return cached;
  const bundle: LocaleBundle = {
    heroes: loadTable(target, "heroes"),
    items: loadTable(target, "items"),
    abilities: loadTable(target, "abilities"),
  };
  bundleCache.set(target, bundle);
  return bundle;
}

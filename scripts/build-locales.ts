/**
 * Build script: fetch Valve's official Dota 2 datafeed for every supported
 * language and write compact locale tables under locales/<lang>/.
 *
 *   heroes.json     { "<hero_id>":    { name, name_en, internal } }
 *   items.json      { "<item_id>":    { name, name_en, internal } }
 *   abilities.json  { "<ability_id>": { name, name_en, internal } }
 *
 * Sources:
 *   https://www.dota2.com/datafeed/herolist?language=<code>
 *   https://www.dota2.com/datafeed/itemlist?language=<code>   (also contains abilities)
 *
 * Run: npm run build:locales
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../locales");

const LANGUAGES = [
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
];

interface DatafeedEntry {
  id: number;
  name: string;
  name_loc: string;
  name_english_loc: string;
}

interface DatafeedResponse {
  result?: { data?: { heroes?: DatafeedEntry[]; itemabilities?: DatafeedEntry[] } };
}

interface LocaleEntry {
  name: string;
  name_en: string;
  internal: string;
}

async function fetchJson(url: string): Promise<DatafeedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as DatafeedResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function derivedName(internal: string): string {
  return internal
    .replace(/^(npc_dota_hero_|npc_dota_)?(item_)?/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Valve loc strings carry unfilled placeholders like "+{s:bonus_damage}% Damage"; strip them. */
function stripLocPlaceholders(s: string): string {
  return s.replace(/\{[sd]:[^}]*\}/g, "").replace(/\s+/g, " ").trim();
}

function toEntry(e: DatafeedEntry): LocaleEntry {
  const name = stripLocPlaceholders(e.name_loc || e.name_english_loc || derivedName(e.name));
  const nameEn = stripLocPlaceholders(e.name_english_loc || e.name_loc || derivedName(e.name));
  return { name, name_en: nameEn, internal: e.name };
}

async function fetchLanguage(lang: string) {
  const [heroFeed, itemFeed, abilityFeed] = await Promise.all([
    fetchJson(`https://www.dota2.com/datafeed/herolist?language=${lang}`),
    fetchJson(`https://www.dota2.com/datafeed/itemlist?language=${lang}`),
    fetchJson(`https://www.dota2.com/datafeed/abilitylist?language=${lang}`),
  ]);
  const heroes: Record<string, LocaleEntry> = {};
  for (const h of heroFeed.result?.data?.heroes ?? []) {
    heroes[String(h.id)] = toEntry(h);
  }
  const items: Record<string, LocaleEntry> = {};
  const abilities: Record<string, LocaleEntry> = {};
  for (const e of [
    ...(itemFeed.result?.data?.itemabilities ?? []),
    ...(abilityFeed.result?.data?.itemabilities ?? []),
  ]) {
    const entry = toEntry(e);
    const target = e.name.startsWith("item_") ? items : abilities;
    // Some ids (e.g. recipe placeholders) repeat; keep the first occurrence.
    if (!target[String(e.id)]) target[String(e.id)] = entry;
  }
  return { heroes, items, abilities };
}

function writeTable(lang: string, table: string, data: Record<string, LocaleEntry>): number {
  const dir = path.join(LOCALES_DIR, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(data, null, 0), "utf8");
  return Object.keys(data).length;
}

function printDirSize(): string {
  let total = 0;
  for (const entry of readdirSync(LOCALES_DIR)) {
    const full = path.join(LOCALES_DIR, entry);
    if (statSync(full).isDirectory()) {
      for (const f of readdirSync(full)) total += statSync(path.join(full, f)).size;
    }
  }
  return `${(total / 1024).toFixed(0)} KiB`;
}

async function main() {
  rmSync(LOCALES_DIR, { recursive: true, force: true });
  mkdirSync(LOCALES_DIR, { recursive: true });
  let failures: string[] = [];
  for (const lang of LANGUAGES) {
    try {
      const { heroes, items, abilities } = await fetchLanguage(lang);
      if (Object.keys(heroes).length === 0) throw new Error("empty hero feed");
      const h = writeTable(lang, "heroes", heroes);
      const i = writeTable(lang, "items", items);
      const a = writeTable(lang, "abilities", abilities);
      console.log(`✓ ${lang.padEnd(12)} heroes=${h} items=${i} abilities=${a}`);
    } catch (err) {
      failures.push(lang);
      console.error(`✗ ${lang}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${LANGUAGES.length - failures.length}/${LANGUAGES.length} languages written to locales/ (${printDirSize()})`);
  if (failures.length > 0) {
    console.error(`Failed languages: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

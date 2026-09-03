/**
 * Build script: regenerates all shipped static data. Run: npm run build:data
 *
 *   locales/<lang>/{heroes,items,abilities}.json — names in 28 languages from
 *     Valve's official datafeed (herolist/itemlist/abilitylist).
 *   constants-bundle/<resource>.json — OpenDota game constants, used at
 *     runtime as a seed for the constants cache so a cold start needs only a
 *     patch-probe request instead of ~9 fetches (see src/index.ts).
 *   constants-bundle/manifest.json — { bundled_at, max_patch_id }; the boot
 *     probe compares max_patch_id and refreshes constants when the API is newer.
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
  const abilityDescriptions = await fetchAbilityDescriptions(lang);
  return { heroes, items, abilities, abilityDescriptions };
}

const VPKR_BASE = "https://raw.githubusercontent.com/dotabuff/d2vpkr/master/dota/resource/localization";

/**
 * Localized ability descriptions from Valve's game files (mirrored by
 * dotabuff/d2vpkr as abilities_<lang>.txt, VDF format). Keys look like
 * DOTA_Tooltip_ability_<internal>_Description. English is skipped: OpenDota
 * constants already provide English descriptions at runtime.
 */
async function fetchAbilityDescriptions(lang: string): Promise<Record<string, string>> {
  if (lang === "english") return {};
  let text: string;
  try {
    const res = await fetch(`${VPKR_BASE}/abilities_${lang}.txt`);
    if (!res.ok) return {};
    text = await res.text();
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  // VDF: "DOTA_Tooltip_ability_<internal>_Description"  "text with \" escapes"
  const re = /"DOTA_Tooltip_ability_([a-z0-9_]+?)_Description"\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    // Unescape VDF string escapes, strip %placeholder% tokens (actual numbers
    // ship in the attributes list next to the description).
    const desc = m[2]
      .replace(/\\\\/g, "\\\\")
      .replace(/\\"/g, '"')
      .replace(/%[a-z0-9_]+%/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (desc && !out[m[1]]) out[m[1]] = desc;
  }
  return out;
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

async function buildConstantsBundle(): Promise<void> {
  const BUNDLE_DIR = path.resolve(__dirname, "../constants-bundle");
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const RESOURCES = [
    "heroes", "items", "item_ids", "abilities", "ability_ids", "game_mode",
    "lobby_type", "region", "patch", "cluster", "chat_wheel", "permanent_buffs",
    "order_types", "hero_abilities", "countries",
  ];
  let maxPatchId = 0;
  let totalBytes = 0;
  for (const resource of RESOURCES) {
    const res = await fetch(`https://api.opendota.com/api/constants/${resource}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${resource}`);
    const data = await res.json();
    const text = JSON.stringify(data);
    writeFileSync(path.join(BUNDLE_DIR, `${resource}.json`), text, "utf8");
    totalBytes += text.length;
    if (resource === "patch" && Array.isArray(data)) {
      maxPatchId = data.reduce((max: number, p: { id?: number }) => Math.max(max, p.id ?? 0), 0);
    }
    console.log(`✓ constants/${resource} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
  const manifest = { bundled_at: new Date().toISOString(), max_patch_id: maxPatchId, resources: RESOURCES };
  writeFileSync(path.join(BUNDLE_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`✓ manifest { max_patch_id: ${maxPatchId} } — bundle total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB`);
}

async function main() {
  rmSync(LOCALES_DIR, { recursive: true, force: true });
  mkdirSync(LOCALES_DIR, { recursive: true });
  let failures: string[] = [];
  for (const lang of LANGUAGES) {
    try {
      const { heroes, items, abilities, abilityDescriptions } = await fetchLanguage(lang);
      if (Object.keys(heroes).length === 0) throw new Error("empty hero feed");
      const h = writeTable(lang, "heroes", heroes);
      const i = writeTable(lang, "items", items);
      const a = writeTable(lang, "abilities", abilities);
      // Descriptions are a plain string map (much bigger than name tables);
      // written minified, skipped entirely when the language file is absent.
      let dCount = 0;
      if (Object.keys(abilityDescriptions).length > 0) {
        const dir = path.join(LOCALES_DIR, lang);
        writeFileSync(path.join(dir, "ability_descriptions.json"), JSON.stringify(abilityDescriptions), "utf8");
        dCount = Object.keys(abilityDescriptions).length;
      }
      console.log(`✓ ${lang.padEnd(12)} heroes=${h} items=${i} abilities=${a} descriptions=${dCount}`);
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
  await buildConstantsBundle();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

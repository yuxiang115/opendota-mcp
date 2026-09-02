import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLocaleBundle } from "./locales.js";

/**
 * Colloquial nicknames (Chinese slang, DotA1-era names, community abbreviations)
 * that appear in NO official constants table. Targets are npc/OpenDota INTERNAL
 * names (stable across patches), never hand-typed numeric ids; an entry whose
 * target no longer exists is silently dropped at resolution time, so a stale
 * alias can never produce a wrong hero.
 *
 * Users can extend/override via a JSON file (OPENDOTA_ALIASES_FILE env, else
 * ~/.config/opendota-mcp/aliases.json):
 *   { "heroes": { "我的外号": "ember_spirit" }, "items": { "我的道具": "blink" } }
 */

export const BUILTIN_HERO_ALIASES: Record<string, string> = {
  // ── 四猫 / 元素使 ──
  火猫: "ember_spirit",
  蓝猫: "storm_spirit",
  土猫: "earth_spirit",
  紫猫: "void_spirit",
  // ── 高频黑话（Dota1 沿袭 + 社区惯称）──
  敌法: "antimage",
  冰女: "crystal_maiden",
  小黑: "drow_ranger",
  小牛: "earthshaker",
  大牛: "elder_titan",
  白牛: "spirit_breaker",
  白虎: "mirana",
  水人: "morphling",
  电棍: "razor",
  电魂: "razor",
  蝎子: "sand_king",
  山岭巨人: "tiny",
  风行: "windrunner",
  船长: "kunkka",
  火女: "lina",
  小y: "shadow_shaman",
  小歪: "shadow_shaman",
  鱼人: "slardar",
  大鱼: "slardar",
  潮汐: "tidehunter",
  隐刺: "riki",
  火枪: "sniper",
  死灵法师: "necrolyte",
  女王: "queenofpain",
  剧毒: "venomancer",
  虚空: "faceless_void",
  骷髅王: "skeleton_king",
  幻刺: "phantom_assassin",
  骨法: "pugna",
  圣堂: "templar_assassin",
  炼金: "alchemist",
  卡尔: "invoker",
  召唤师: "invoker",
  沉默: "silencer",
  黑鸟: "obsidian_destroyer",
  赏金: "bounty_hunter",
  龙骑: "dragon_knight",
  小鹿: "enchantress",
  神灵武士: "huskar",
  夜魔: "night_stalker",
  蜘蛛: "broodmother",
  蚂蚁: "weaver",
  冰魄: "ancient_apparition",
  末日: "doom_bringer",
  猛犸: "magnataur",
  蝙蝠: "batrider",
  飞机: "gyrocopter",
  穿山甲: "pangolier",
  墨客: "grimstroke",
  松鼠: "hoodwink",
  破晓: "dawnbreaker",
  老奶奶: "snapfire",
  小狗: "life_stealer",
  灵魂守卫: "terrorblade",
  电狗: "arc_warden",
  冰龙: "winter_wyvern",
  神谕: "oracle",
  炸弹人: "techies",
  军团: "legion_commander",
  小鱼: "slark",
  小娜迦: "naga_siren",
  大树: "treant",
  人马: "centaur",
  半人马: "centaur",
  钢背: "bristleback",
  海民: "tusk",
  天怒: "skywrath_mage",
  尸王: "undying",
  蓝胖: "ogre_magi",
  小精灵: "wisp",
  混沌: "chaos_knight",
  死先知: "death_prophet",
  毒龙: "viper",
  骨弓: "clinkz",
  光法: "keeper_of_the_light",
  屠夫: "pudge",
  发条: "rattletrap",
  地卜师: "meepo",
  黑贤: "dark_seer",
  月骑: "luna",
  蛇发女妖: "medusa",
  死灵龙: "visage",
  先知: "furion",
  萨尔: "disruptor",
  小强: "nyx_assassin",
  深渊领主: "abyssal_underlord",
  大屁股: "abyssal_underlord",
  // ── 英文缩写（官方/内名子串已能匹配的不重复收）──
  pa: "phantom_assassin",
  ta: "templar_assassin",
  qop: "queenofpain",
  sf: "nevermore",
  od: "obsidian_destroyer",
  wk: "skeleton_king",
  mk: "monkey_king",
  np: "furion",
  kotl: "keeper_of_the_light",
  ld: "lone_druid",
  aw: "arc_warden",
  ww: "winter_wyvern",
  ns: "night_stalker",
  ck: "chaos_knight",
  dp: "death_prophet",
  lc: "legion_commander",
  tb: "terrorblade",
  aa: "ancient_apparition",
  io: "wisp",
  vs: "vengefulspirit",
  tk: "tinker",
  dk: "dragon_knight",
  sk: "sand_king",
  bs: "bloodseeker",
  am: "antimage",
  wr: "windrunner",
  cm: "crystal_maiden",
  wd: "witch_doctor",
  wl: "warlock",
  nec: "necrolyte",
};

/** Nicknames that mean different heroes to different people — never auto-pick. */
export const BUILTIN_AMBIGUOUS_HEROES: Record<string, string[]> = {
  猴子: ["phantom_lancer", "monkey_king"], // 幻影长矛手(老) vs 齐天大圣(新)
  es: ["earthshaker", "ember_spirit", "earth_spirit", "void_spirit"],
  bm: ["beastmaster", "broodmother"],
};

export const BUILTIN_ITEM_ALIASES: Record<string, string> = {
  跳刀: "blink",
  bkb: "black_king_bar",
  大骨灰: "spirit_vessel",
  骨灰: "spirit_vessel",
  小骨灰: "urn_of_shadows",
  骨灰盒: "urn_of_shadows",
  a杖: "ultimate_scepter",
  神杖: "ultimate_scepter",
  魔晶: "aghanims_shard",
  a晶: "aghanims_shard",
  龙心: "heart",
  羊刀: "sheepstick",
  绿杖: "ghost",
  虚灵刀: "ethereal_blade",
  推推: "force_staff",
  推推棒: "force_staff",
  吹风: "cyclone",
  大根: "dagon",
  红杖: "dagon",
  分身斧: "manta",
  散失: "diffusal_blade",
  冰眼: "skadi",
  大炮: "greater_crit",
  狂战: "bfury",
  深渊: "abyssal_blade",
  强袭: "assault",
  希瓦: "shivas_guard",
  玲珑心: "octarine_core",
  刷新: "refresher",
  小电锤: "maelstrom",
  大电锤: "mjollnir",
  祭品: "vladmir",
  秘法鞋: "arcane_boots",
  飞鞋: "travel_boots",
  点金手: "hand_of_midas",
  真眼: "ward_sentry",
  假眼: "ward_observer",
  粉: "dust",
  雾: "smoke_of_deceit",
  银月: "moon_shard",
  血精: "bloodstone",
  笛子: "pipe",
  赤红: "crimson_guard",
  莲花: "lotus_orb",
  微光: "glimmer_cape",
  小人书: "necronomicon",
  否决: "nullifier",
  双刀: "sange_and_yasha",
  散夜: "sange_and_yasha",
  回音: "echo_sabre",
  林肯: "sphere",
  吃树: "tango",
  大药: "flask",
  小蓝: "clarity",
  芒果: "enchanted_mango",
  tp: "tpscroll",
  魔棒: "magic_stick",
  魔杖: "magic_wand",
  瓶子: "bottle",
};

export interface AliasTables {
  heroes: Record<string, string>;
  items: Record<string, string>;
  ambiguous: Record<string, string[]>;
}

let merged: AliasTables | undefined;

function userAliasFile(): string | undefined {
  const fromEnv = process.env.OPENDOTA_ALIASES_FILE;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const p = path.join(os.homedir(), ".config", "opendota-mcp", "aliases.json");
  return existsSync(p) ? p : undefined;
}

/** Builtin tables + optional user file. User entries win. Cached per process. */
export function getAliasTables(): AliasTables {
  if (merged) return merged;
  const tables: AliasTables = {
    heroes: { ...BUILTIN_HERO_ALIASES },
    items: { ...BUILTIN_ITEM_ALIASES },
    ambiguous: { ...BUILTIN_AMBIGUOUS_HEROES },
  };
  const file = userAliasFile();
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw.heroes ?? {})) {
          if (typeof v === "string") tables.heroes[k.toLowerCase()] = v;
        }
        for (const [k, v] of Object.entries(raw.items ?? {})) {
          if (typeof v === "string") tables.items[k.toLowerCase()] = v;
        }
        for (const [k, v] of Object.entries(raw.ambiguous ?? {})) {
          if (Array.isArray(v)) tables.ambiguous[k.toLowerCase()] = v.filter((x) => typeof x === "string");
        }
      }
    } catch {
      // A malformed user file must never break the server; builtin tables still apply.
    }
  }
  merged = tables;
  return tables;
}

/** internal hero name -> hero id via the English constants bundle (invalid targets → undefined). */
export function internalHeroToId(internal: string): number | undefined {
  // Bundle internals carry the full npc prefix ("npc_dota_hero_ember_spirit");
  // alias targets use the bare form ("ember_spirit") — normalize both sides.
  const bare = internal.replace(/^npc_dota_hero_/, "");
  for (const [id, entry] of Object.entries(getLocaleBundle("english").heroes)) {
    if (entry.internal.replace(/^npc_dota_hero_/, "") === bare) return Number(id);
  }
  return undefined;
}

export interface HeroAliasHit {
  internal: string;
  id: number;
}
export type HeroAliasResult = HeroAliasHit | { ambiguous: string[] } | undefined;

/** Exact nickname lookup. Ambiguous terms return their candidates, never a guess. */
export function lookupHeroAlias(query: string): HeroAliasResult {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const tables = getAliasTables();
  const amb = tables.ambiguous[q];
  if (amb) return { ambiguous: amb };
  const internal = tables.heroes[q];
  if (!internal) return undefined;
  const id = internalHeroToId(internal);
  return id == null ? undefined : { internal, id };
}

/** Exact item-nickname lookup -> internal item name (existence checked by the caller). */
export function lookupItemAlias(query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return getAliasTables().items[q];
}

/** Enriched "hero not found" error: ambiguous nicknames list their candidates. */
export function heroLookupError(
  input: string | number,
  lang: string,
): { error: string; hint: string; ambiguous?: { alias: string; candidates: { id: number; name: string; name_en: string }[] } } {
  const raw = String(input);
  const q = raw.trim().toLowerCase();
  const amb = getAliasTables().ambiguous[q];
  if (amb) {
    const candidates = amb
      .map((internal) => {
        const id = internalHeroToId(internal);
        if (id == null) return undefined;
        const en = getLocaleBundle("english").heroes[String(id)];
        const loc = getLocaleBundle(lang).heroes[String(id)];
        return { id, name: loc?.name ?? en?.name ?? internal, name_en: en?.name_en ?? internal };
      })
      .filter((c): c is { id: number; name: string; name_en: string } => c != null);
    return {
      error: `"${raw}" is an ambiguous nickname — it can mean several heroes.`,
      hint: "Ask the user which hero they mean, then retry with that hero.",
      ambiguous: { alias: raw, candidates },
    };
  }
  return {
    error: `Unknown hero: ${raw}`,
    hint: "Resolve names to ids with search_dota_entities first — it also knows community nicknames like 火猫/大骨灰/BKB.",
  };
}

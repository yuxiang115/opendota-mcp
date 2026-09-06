/**
 * Typo-tolerant name matching — the layer that keeps small models from
 * derailing on "batle fury" / "amti mage". Bigram-Dice similarity (no deps,
 * no order penalty for transpositions), with per-entity tiered thresholds
 * tuned the way hkaanengin/opendota-mcp-server validated them (0.9 adopt /
 * 0.8 good / 0.7 loose; 0.6 for short strings; 0.5 suggestion floor).
 */

export const FUZZY_HIGH = 0.9;
export const FUZZY_GOOD = 0.8;
export const FUZZY_LOOSE = 0.7;
export const FUZZY_SHORT = 0.6;
export const FUZZY_SUGGEST = 0.5;

export function normalizeForFuzzy(s: string): string {
  return s.toLowerCase().replace(/[\s\-_'.]/g, "");
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Bigram-Dice coefficient in [0,1]; 1 = identical char-pair sets. */
export function similarity(a: string, b: string): number {
  const x = normalizeForFuzzy(a);
  const y = normalizeForFuzzy(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (bx.size === 0 || by.size === 0) return x === y ? 1 : 0;
  let hits = 0;
  for (const g of bx) if (by.has(g)) hits++;
  return (2 * hits) / (bx.size + by.size);
}

export interface FuzzyCandidate {
  /** Display value returned on a hit (e.g. "Anti-Mage"). */
  value: string;
  /** Extra strings scored alongside value (aliases, internal names). */
  also?: string[];
}

export interface FuzzyHit {
  value: string;
  score: number;
  match_type: "fuzzy";
}

/** Best candidate above `min`, or undefined. */
export function bestFuzzyMatch(query: string, candidates: FuzzyCandidate[], min: number): FuzzyHit | undefined {
  let best: { value: string; score: number } | undefined;
  for (const c of candidates) {
    const score = Math.max(similarity(query, c.value), ...(c.also ?? []).map((a) => similarity(query, a)));
    if (score >= min && (!best || score > best.score)) best = { value: c.value, score };
  }
  return best ? { ...best, match_type: "fuzzy" } : undefined;
}

/** Top-N candidates above the suggestion floor, best first. */
export function topSuggestions(query: string, candidates: FuzzyCandidate[], n = 3): string[] {
  const min = query.trim().length <= 4 ? FUZZY_SHORT : FUZZY_SUGGEST;
  return candidates
    .map((c) => ({
      value: c.value,
      score: Math.max(similarity(query, c.value), ...(c.also ?? []).map((a) => similarity(query, a))),
    }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.value);
}

/** Threshold an entity class should auto-adopt at (short names match looser). */
export function adoptThreshold(entity: "hero" | "item" | "ability" | "field"): number {
  return entity === "field" ? FUZZY_GOOD : FUZZY_HIGH;
}

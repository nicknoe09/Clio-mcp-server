const NOISE_TOKENS = new Set([
  "inc", "llc", "corp", "the", "and", "co", "store", "ltd", "llp",
  "company", "corporation", "incorporated", "limited", "services",
  "group", "holdings", "enterprises", "international", "assoc",
  "association", "partners", "partnership",
]);

/**
 * Normalize a merchant/description string for comparison.
 * Lowercase, strip punctuation and special characters, remove noise tokens.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => !NOISE_TOKENS.has(token) && token.length > 0)
    .join(" ");
}

/**
 * Tokenize a normalized string into a Set of words.
 */
export function tokenize(text: string): Set<string> {
  const normalized = normalizeText(text);
  return new Set(normalized.split(" ").filter((t) => t.length > 0));
}

/**
 * Compute Jaccard similarity between two strings.
 * Returns a value between 0 and 1.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if any token from a overlaps with tokens in b.
 */
export function hasTokenOverlap(a: string, b: string): boolean {
  const setA = tokenize(a);
  const setB = tokenize(b);
  for (const token of setA) {
    if (setB.has(token)) return true;
  }
  return false;
}

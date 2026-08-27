// =====================================================================
// Practice-area lookup + resolution.
//
// Clio references practice areas by ID, never by name, so anything that
// wants to set one has to map a human-typed name onto an ID first. That
// mapping is the only place this can silently go wrong — pick the wrong
// row and a matter gets mislabeled with no error anywhere — so the
// resolution is pure and unit-tested, and it REFUSES rather than guesses:
// no fuzzy matching, no "closest" name, no picking the first of several.
// =====================================================================

export interface PracticeAreaLite {
  id: number;
  name: string;
}

export type PracticeAreaResolution =
  | { ok: true; id: number; name: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matches: PracticeAreaLite[] };

/** Case- and whitespace-insensitive comparison key for a practice-area name. */
export function practiceAreaKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Map a practice-area name onto its Clio ID.
 *
 * Matching is exact after case folding and whitespace collapsing — "dependent
 * administration" resolves to "Dependent Administration", but "Dependent Admin"
 * does not resolve to anything. Duplicate names in Clio come back as
 * `ambiguous` with the candidates, so the caller can ask for an ID instead.
 */
export function resolvePracticeAreaByName(
  name: string,
  areas: PracticeAreaLite[]
): PracticeAreaResolution {
  const key = practiceAreaKey(name);
  if (!key) return { ok: false, reason: "not_found" };

  const matches = areas.filter((a) => practiceAreaKey(a.name ?? "") === key);
  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: true, id: matches[0].id, name: matches[0].name };
}

/**
 * The PATCH body that moves a matter to a practice area.
 * Clio expects the association as an object with an id, not a bare integer.
 */
export function buildPracticeAreaPatch(practiceAreaId: number): {
  data: { practice_area: { id: number } };
} {
  return { data: { practice_area: { id: practiceAreaId } } };
}

/**
 * Whether a PATCH is needed at all. Re-sending the practice area a matter
 * already has is a pointless write against a system of record, and a caller
 * re-running a batch should be able to tell "already correct" from "changed".
 */
export function isAlreadySet(
  current: { id?: number | null } | null | undefined,
  targetId: number
): boolean {
  return !!current && current.id === targetId;
}

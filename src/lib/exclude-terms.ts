// Canonical comma/newline grammar for saved-search exclusions.
export function splitExcludeTerms(excludeTerms: string | null): string[] {
  return (excludeTerms ?? "")
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

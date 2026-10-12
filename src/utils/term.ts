/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

export interface CourseTerm {
  /** Short code, e.g. "FA26". */
  code: string;
  /** Human label, e.g. "Fall 2026". */
  label: string;
}

const SEASONS: Record<string, string> = {
  FA: "Fall",
  SP: "Spring",
  SU: "Summer",
  WI: "Winter",
  JA: "January",
  JT: "January",
};

/**
 * The academic term a course belongs to. Course codes that carry a term
 * (NYU's "FA26_CSCI-UA_473_..." or "519-1254_SP25 MA-UY ...") are read
 * directly; otherwise the term is inferred from the enrollment start date.
 * Returns null for an undated, uncoded org unit such as a club or a
 * placement-exam site, which belongs to no term.
 */
export function courseTerm(code: string | null | undefined, startDate?: string | null): CourseTerm | null {
  const match = /(?:^|[_\s-])(FA|SP|SU|WI|JA|JT)(\d{2})(?=[_\s-]|$)/.exec(code ?? "");
  if (match) {
    const season = match[1] === "JT" ? "JA" : match[1];
    return { code: `${season}${match[2]}`, label: `${SEASONS[season]} 20${match[2]}` };
  }
  if (!startDate) return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;
  const month = start.getUTCMonth(); // 0 = January
  const year = start.getUTCFullYear();
  const season = month >= 7 ? "FA" : month >= 4 ? "SU" : "SP";
  return { code: `${season}${String(year).slice(2)}`, label: `${SEASONS[season]} ${year}` };
}

/** True when a term argument such as "FA26", "fall 2026" or "Fall 2026" names this term. */
export function matchesTerm(term: CourseTerm | null, wanted: string): boolean {
  if (!term) return false;
  const w = wanted.trim().toLowerCase().replace(/\s+/g, " ");
  return w === term.code.toLowerCase() || w === term.label.toLowerCase();
}

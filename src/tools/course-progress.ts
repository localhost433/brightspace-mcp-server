/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * The arithmetic behind get_course_progress, kept free of I/O so it can be
 * tested against plain gradebook rows.
 */

export interface GradeObjectDto {
  Id: number;
  Name: string;
  GradeType?: string;
  MaxPoints?: number | null;
  Weight?: number | null;
  CategoryId?: number | null;
  IsBonus?: boolean;
  ExcludeFromFinalGradeCalculation?: boolean;
  IsHidden?: boolean;
}

export interface GradeValueDto {
  GradeObjectIdentifier: string | number;
  GradeObjectName: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  DisplayedGrade?: string | null;
}

export interface GradeCategoryDto {
  Id: number;
  Name: string;
  Weight?: number | null;
}

export interface GradeItemProgress {
  name: string;
  category: string | null;
  score: string | null;
  percent: number | null;
  displayedGrade: string | null;
  weight: number | null;
  bonus: boolean;
  graded: boolean;
}

export interface GradeSummary {
  gradingSystem: string;
  /** Running grade over graded items only, 0-100, or null when nothing is graded. */
  runningPercent: number | null;
  pointsEarned: number;
  pointsPossible: number;
  gradedCount: number;
  ungradedCount: number;
  /** Share of the course's weight (or points) already graded, 0-100. */
  gradedShare: number | null;
  categories: Array<{ name: string; weight: number | null; percent: number | null; graded: number; total: number }>;
  items: GradeItemProgress[];
  method: string;
}

/** Gradebook column types that hold a student's score (not the gradebook's own arithmetic or text). */
const SCORED_TYPES = new Set(["Numeric", "PassFail", "SelectBox"]);

/** The displayed grade when it adds something (a letter); null when it only restates the points. */
function letterGrade(displayed: string | null | undefined): string | null {
  const text = displayed?.trim();
  if (!text || /^[\d.\s/%]+$/.test(text)) return null;
  return text;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * A running grade from the released grade values. Brightspace's own final
 * calculated grade is often unreleased to students (NYU returns 404 for it
 * even after a course ends), so this reproduces the calculation over what is
 * graded so far: points earned over points possible in a Points gradebook,
 * or category/item weights in a Weighted one. Drop-lowest rules and
 * instructor adjustments are not visible to students, so it is an estimate.
 */
export function computeGradeSummary(
  objects: GradeObjectDto[],
  values: GradeValueDto[],
  gradingSystem: string,
  categories: GradeCategoryDto[]
): GradeSummary {
  const valueById = new Map(values.map((v) => [String(v.GradeObjectIdentifier), v]));
  const categoryById = new Map(categories.map((c) => [c.Id, c]));
  const scored = objects.filter(
    (o) => SCORED_TYPES.has(o.GradeType ?? "Numeric") && !o.ExcludeFromFinalGradeCalculation && (o.MaxPoints ?? 0) > 0
  );

  const items: GradeItemProgress[] = scored.map((o) => {
    const v = valueById.get(String(o.Id));
    const graded = v !== undefined && v.PointsNumerator !== null && v.PointsDenominator !== null;
    const max = v?.PointsDenominator ?? o.MaxPoints ?? null;
    return {
      name: o.Name,
      category: o.CategoryId ? categoryById.get(o.CategoryId)?.Name ?? null : null,
      score: graded ? `${v!.PointsNumerator}/${max}` : null,
      percent: graded && max ? round1((v!.PointsNumerator! / max) * 100) : null,
      displayedGrade: graded ? letterGrade(v!.DisplayedGrade) : null,
      weight: o.Weight ?? null,
      bonus: Boolean(o.IsBonus),
      graded,
    };
  });

  // Values for columns that are not in the object list (hidden setup, or a
  // tenant that withholds /grades/) still count as graded points.
  const knownIds = new Set(scored.map((o) => String(o.Id)));
  for (const v of values) {
    if (knownIds.has(String(v.GradeObjectIdentifier)) || v.PointsNumerator === null || !v.PointsDenominator) continue;
    if (objects.some((o) => String(o.Id) === String(v.GradeObjectIdentifier))) continue;
    items.push({
      name: v.GradeObjectName,
      category: null,
      score: `${v.PointsNumerator}/${v.PointsDenominator}`,
      percent: round1((v.PointsNumerator / v.PointsDenominator) * 100),
      displayedGrade: letterGrade(v.DisplayedGrade),
      weight: null,
      bonus: false,
      graded: true,
    });
  }

  const graded = items.filter((i) => i.graded);
  const pointsOf = (i: GradeItemProgress) => {
    const [num, den] = (i.score ?? "0/0").split("/").map(Number);
    return { num, den: i.bonus ? 0 : den };
  };
  const pointsEarned = graded.reduce((s, i) => s + pointsOf(i).num, 0);
  const pointsPossible = graded.reduce((s, i) => s + pointsOf(i).den, 0);

  // Category view: points within each category.
  const categorySummaries = categories.map((c) => {
    const inCat = items.filter((i) => i.category === c.Name);
    const g = inCat.filter((i) => i.graded);
    const den = g.reduce((s, i) => s + pointsOf(i).den, 0);
    const num = g.reduce((s, i) => s + pointsOf(i).num, 0);
    return { name: c.Name, weight: c.Weight ?? null, percent: den > 0 ? round1((num / den) * 100) : null, graded: g.length, total: inCat.length };
  });

  let runningPercent: number | null = null;
  let gradedShare: number | null = null;
  let method: string;
  const weighted = /weight/i.test(gradingSystem);

  if (weighted && categorySummaries.some((c) => c.weight)) {
    // Weighted by category; uncategorized items act as their own category.
    const parts: Array<{ weight: number; percent: number | null }> = [
      ...categorySummaries.map((c) => ({ weight: c.weight ?? 0, percent: c.percent })),
      ...items.filter((i) => i.category === null && !i.bonus).map((i) => ({ weight: i.weight ?? 0, percent: i.percent })),
    ];
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const gradedParts = parts.filter((p) => p.percent !== null && p.weight > 0);
    const gradedWeight = gradedParts.reduce((s, p) => s + p.weight, 0);
    runningPercent = gradedWeight > 0 ? round1(gradedParts.reduce((s, p) => s + p.weight * p.percent!, 0) / gradedWeight) : null;
    gradedShare = totalWeight > 0 ? round1((gradedWeight / totalWeight) * 100) : null;
    method = "Weighted gradebook: category weights applied to each category's points earned/possible, normalized over graded categories.";
  } else if (weighted) {
    const nonBonus = items.filter((i) => !i.bonus);
    const totalWeight = nonBonus.reduce((s, i) => s + (i.weight ?? 0), 0);
    const gradedItems = nonBonus.filter((i) => i.graded && (i.weight ?? 0) > 0);
    const gradedWeight = gradedItems.reduce((s, i) => s + (i.weight ?? 0), 0);
    runningPercent = gradedWeight > 0 ? round1(gradedItems.reduce((s, i) => s + (i.weight ?? 0) * (i.percent ?? 0), 0) / gradedWeight) : null;
    gradedShare = totalWeight > 0 ? round1((gradedWeight / totalWeight) * 100) : null;
    method = "Weighted gradebook: item weights applied to each graded item's percentage, normalized over graded items.";
  } else {
    const totalPossible = items.filter((i) => !i.bonus).reduce((s, i) => {
      if (i.graded) return s + pointsOf(i).den;
      const obj = scored.find((o) => o.Name === i.name);
      return s + (obj?.MaxPoints ?? 0);
    }, 0);
    runningPercent = pointsPossible > 0 ? round1((pointsEarned / pointsPossible) * 100) : null;
    gradedShare = totalPossible > 0 ? round1((pointsPossible / totalPossible) * 100) : null;
    method = "Points gradebook: points earned over points possible on graded items.";
  }

  return {
    gradingSystem,
    runningPercent,
    pointsEarned: round1(pointsEarned),
    pointsPossible: round1(pointsPossible),
    gradedCount: graded.length,
    ungradedCount: items.length - graded.length,
    gradedShare,
    categories: categorySummaries,
    items,
    method,
  };
}

export interface WorkItem {
  type: string;
  name: string;
  dueDate?: string | null;
  dueIn?: string | null;
  submissionStatus?: string;
  attemptStatus?: string;
  attemptsUsed?: number | null;
}

export interface WorkSummary {
  done: number;
  pastDueNotDone: Array<{ name: string; dueDate: string }>;
  upcoming: Array<{ name: string; dueDate: string; dueIn: string | null }>;
  unknown: number;
}

/**
 * Turned-in, overdue and upcoming work from get_assignments' rows. An item
 * whose submission data Brightspace withheld counts as unknown, never as
 * missing.
 */
export function summarizeWork(items: WorkItem[], now: number = Date.now()): WorkSummary {
  const summary: WorkSummary = { done: 0, pastDueNotDone: [], upcoming: [], unknown: 0 };
  for (const item of items) {
    let status: "done" | "notDone" | "unknown";
    if (item.type === "assignment") {
      status = item.submissionStatus === "submitted" ? "done" : item.submissionStatus === "not_submitted" ? "notDone" : "unknown";
    } else if (item.type === "quiz") {
      status = item.attemptStatus !== "known" ? "unknown" : (item.attemptsUsed ?? 0) > 0 ? "done" : "notDone";
    } else {
      continue;
    }
    const due = item.dueDate ? Date.parse(item.dueDate) : NaN;
    if (status === "done") summary.done++;
    else if (status === "unknown") summary.unknown++;
    else if (!Number.isNaN(due) && due < now) summary.pastDueNotDone.push({ name: item.name, dueDate: item.dueDate! });
    if (status !== "done" && !Number.isNaN(due) && due >= now) {
      summary.upcoming.push({ name: item.name, dueDate: item.dueDate!, dueIn: item.dueIn ?? null });
    }
  }
  summary.upcoming.sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
  summary.pastDueNotDone.sort((a, b) => Date.parse(b.dueDate) - Date.parse(a.dueDate));
  return summary;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

export interface CourseProgress {
  courseId: number;
  courseName: string | null;
  grades: (GradeSummary & { finalGrade: { released: boolean; displayedGrade?: string | null; percent?: number | null } }) | { unavailable: string };
  work: WorkSummary | { unavailable: string };
  content?: { completed: number; total: number; source: string; modules: Array<{ title: string; completed: number; total: number }> };
}

/** A short Markdown report for one course. */
export function renderProgressMarkdown(p: CourseProgress): string {
  const lines = [`## ${p.courseName ?? `Course ${p.courseId}`}`];

  if ("unavailable" in p.grades) {
    lines.push(`Grades: ${p.grades.unavailable}`);
  } else {
    const g = p.grades;
    const final = g.finalGrade.released
      ? `Final grade: ${g.finalGrade.displayedGrade ?? `${g.finalGrade.percent}%`}.`
      : "Final grade not released.";
    if (g.runningPercent === null) {
      lines.push(`Grade so far: nothing graded yet (${g.ungradedCount} item${g.ungradedCount === 1 ? "" : "s"} in the gradebook). ${final}`);
    } else {
      const share = g.gradedShare !== null ? `, ${g.gradedShare}% of the course graded` : "";
      lines.push(
        `Grade so far: ${g.runningPercent}% (${g.pointsEarned}/${g.pointsPossible} points on ${g.gradedCount} graded item${g.gradedCount === 1 ? "" : "s"}${share}; ${g.ungradedCount} not graded yet). ${final}`
      );
    }
  }

  if ("unavailable" in p.work) {
    lines.push(`Work: ${p.work.unavailable}`);
  } else {
    const w = p.work;
    const parts = [`${w.done} turned in`];
    if (w.pastDueNotDone.length > 0) {
      parts.push(`${w.pastDueNotDone.length} past due and not turned in (${w.pastDueNotDone.slice(0, 3).map((i) => `${i.name}, due ${shortDate(i.dueDate)}`).join("; ")})`);
    }
    if (w.upcoming.length > 0) {
      const next = w.upcoming[0];
      parts.push(`${w.upcoming.length} upcoming (next: ${next.name}, ${next.dueIn ?? `due ${shortDate(next.dueDate)}`})`);
    }
    if (w.unknown > 0) parts.push(`${w.unknown} with submission status unknown (check Brightspace)`);
    lines.push(`Work: ${parts.join(", ")}.`);
  }

  if (p.content) {
    const c = p.content;
    if (c.source === "unavailable") {
      lines.push("Content: completion tracking unavailable for this course.");
    } else if (c.total > 0) {
      const pct = Math.round((c.completed / c.total) * 100);
      lines.push(`Content: ${c.completed}/${c.total} topics completed (${pct}%).`);
    }
  }

  if (!("unavailable" in p.grades) && p.grades.items.length > 0) {
    lines.push("", "| Item | Score | % | Grade |", "| --- | --- | --- | --- |");
    for (const item of p.grades.items) {
      const name = `${item.name}${item.bonus ? " (bonus)" : ""}`.replace(/\|/g, "\\|");
      lines.push(`| ${name} | ${item.score ?? "not graded"} | ${item.percent ?? ""} | ${item.displayedGrade ?? ""} |`);
    }
  }

  if (p.content && p.content.modules.length > 0 && p.content.source !== "unavailable") {
    lines.push("", "| Module | Completed |", "| --- | --- |");
    for (const m of p.content.modules) {
      lines.push(`| ${m.title.replace(/\|/g, "\\|")} | ${m.completed}/${m.total} |`);
    }
  }

  return lines.join("\n");
}

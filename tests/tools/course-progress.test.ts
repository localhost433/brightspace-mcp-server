import { describe, it, expect } from "vitest";
import {
  computeGradeSummary,
  renderProgressMarkdown,
  summarizeWork,
  type GradeObjectDto,
  type GradeValueDto,
} from "../../src/tools/course-progress.js";

const obj = (Id: number, Name: string, MaxPoints: number, extra: Partial<GradeObjectDto> = {}): GradeObjectDto => ({
  Id, Name, MaxPoints, GradeType: "Numeric", CategoryId: 0, Weight: 0, IsBonus: false, ExcludeFromFinalGradeCalculation: false, ...extra,
});
const val = (id: number, name: string, num: number, den: number, shown: string | null = null): GradeValueDto => ({
  GradeObjectIdentifier: String(id), GradeObjectName: name, PointsNumerator: num, PointsDenominator: den, DisplayedGrade: shown,
});

describe("computeGradeSummary", () => {
  it("sums points over graded items in a Points gradebook", () => {
    // The shape of a real NYU course: four 100-point items, three graded.
    const g = computeGradeSummary(
      [obj(1, "HW1", 100), obj(2, "HW2", 100), obj(3, "Quiz 1", 100), obj(4, "HW3", 100)],
      [val(1, "HW1", 100, 100, "A"), val(2, "HW2", 80, 100, "B- "), val(3, "Quiz 1", 70, 100, "C")],
      "Points",
      []
    );
    expect(g.runningPercent).toBe(83.3);
    expect(g).toMatchObject({ pointsEarned: 250, pointsPossible: 300, gradedCount: 3, ungradedCount: 1, gradedShare: 75 });
    expect(g.items[1]).toMatchObject({ score: "80/100", percent: 80, displayedGrade: "B-" });
    expect(g.items[3]).toMatchObject({ graded: false, score: null });
  });

  it("counts bonus points earned but not their maximum", () => {
    const g = computeGradeSummary(
      [obj(1, "HW1", 10), obj(2, "Extra", 5, { IsBonus: true })],
      [val(1, "HW1", 8, 10), val(2, "Extra", 5, 5)],
      "Points",
      []
    );
    expect(g.runningPercent).toBe(130);
    expect(g.pointsPossible).toBe(10);
  });

  it("leaves out excluded and non-scored columns", () => {
    const g = computeGradeSummary(
      [obj(1, "HW1", 10), obj(2, "Practice", 10, { ExcludeFromFinalGradeCalculation: true }), obj(3, "Total", 100, { GradeType: "Formula" })],
      [val(1, "HW1", 5, 10), val(2, "Practice", 0, 10)],
      "Points",
      []
    );
    expect(g.items.map((i) => i.name)).toEqual(["HW1"]);
    expect(g.runningPercent).toBe(50);
  });

  it("weights items by their weight in a Weighted gradebook without categories", () => {
    const g = computeGradeSummary(
      [obj(1, "Midterm", 100, { Weight: 30 }), obj(2, "HW", 10, { Weight: 10 }), obj(3, "Final", 100, { Weight: 60 })],
      [val(1, "Midterm", 90, 100), val(2, "HW", 5, 10)],
      "Weighted",
      []
    );
    // (30*90 + 10*50) / 40
    expect(g.runningPercent).toBe(80);
    expect(g.gradedShare).toBe(40);
  });

  it("weights categories by their weight, over graded categories only", () => {
    const g = computeGradeSummary(
      [
        obj(1, "HW1", 10, { CategoryId: 7 }),
        obj(2, "HW2", 10, { CategoryId: 7 }),
        obj(3, "Exam", 100, { CategoryId: 8 }),
      ],
      [val(1, "HW1", 10, 10), val(2, "HW2", 6, 10)],
      "Weighted",
      [{ Id: 7, Name: "Homework", Weight: 40 }, { Id: 8, Name: "Exams", Weight: 60 }]
    );
    expect(g.categories).toEqual([
      { name: "Homework", weight: 40, percent: 80, graded: 2, total: 2 },
      { name: "Exams", weight: 60, percent: null, graded: 0, total: 1 },
    ]);
    expect(g.runningPercent).toBe(80);
    expect(g.gradedShare).toBe(40);
  });

  it("drops a displayed grade that only restates the points", () => {
    const g = computeGradeSummary([obj(1, "hw1", 30)], [val(1, "hw1", 24, 30, "24 / 30")], "Points", []);
    expect(g.items[0].displayedGrade).toBeNull();
  });

  it("still counts a released value whose column the object list omits", () => {
    const g = computeGradeSummary([], [val(9, "Lab 1", 9, 10)], "Points", []);
    expect(g.runningPercent).toBe(90);
    expect(g.items[0].name).toBe("Lab 1");
  });

  it("reports nothing graded as null, not zero", () => {
    expect(computeGradeSummary([obj(1, "HW1", 10)], [], "Points", []).runningPercent).toBeNull();
  });
});

describe("summarizeWork", () => {
  const NOW = Date.parse("2026-10-12T12:00:00.000Z");

  it("separates turned in, past due, upcoming and unknown", () => {
    const w = summarizeWork(
      [
        { type: "assignment", name: "HW1", dueDate: "2026-09-10T00:00:00.000Z", submissionStatus: "submitted" },
        { type: "assignment", name: "HW2", dueDate: "2026-10-01T00:00:00.000Z", submissionStatus: "not_submitted" },
        { type: "assignment", name: "HW3", dueDate: "2026-10-20T00:00:00.000Z", dueIn: "next week", submissionStatus: "not_submitted" },
        { type: "assignment", name: "HW4", dueDate: "2026-10-01T00:00:00.000Z", submissionStatus: "unknown" },
        { type: "quiz", name: "Quiz 1", dueDate: "2026-09-20T00:00:00.000Z", attemptStatus: "known", attemptsUsed: 1 },
        { type: "gradeOnly", name: "Participation" },
      ],
      NOW
    );
    expect(w.done).toBe(2);
    expect(w.pastDueNotDone).toEqual([{ name: "HW2", dueDate: "2026-10-01T00:00:00.000Z" }]);
    expect(w.upcoming).toEqual([{ name: "HW3", dueDate: "2026-10-20T00:00:00.000Z", dueIn: "next week" }]);
    expect(w.unknown).toBe(1);
  });
});

describe("renderProgressMarkdown", () => {
  it("leads with the running grade, work and content lines", () => {
    const grades = computeGradeSummary([obj(1, "HW1", 100), obj(2, "HW2", 100)], [val(1, "HW1", 90, 100, "A-")], "Points", []);
    const md = renderProgressMarkdown({
      courseId: 1,
      courseName: "Algebra",
      grades: { ...grades, finalGrade: { released: false } },
      work: { done: 1, pastDueNotDone: [], upcoming: [{ name: "HW2", dueDate: "2026-10-20T00:00:00.000Z", dueIn: "in 8 days" }], unknown: 0 },
      content: { completed: 3, total: 4, source: "topicCompletions", modules: [{ title: "Week 1", completed: 3, total: 4 }] },
    });
    expect(md).toContain("## Algebra");
    expect(md).toContain("Grade so far: 90% (90/100 points on 1 graded item, 50% of the course graded; 1 not graded yet). Final grade not released.");
    expect(md).toContain("Work: 1 turned in, 1 upcoming (next: HW2, in 8 days).");
    expect(md).toContain("Content: 3/4 topics completed (75%).");
    expect(md).toContain("| HW1 | 90/100 | 90 | A- |");
    expect(md).toContain("| Week 1 | 3/4 |");
  });
});

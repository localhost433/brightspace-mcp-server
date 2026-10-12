/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { ApiError } from "../api/errors.js";
import type { AppConfig } from "../types/index.js";
import { GetCourseProgressSchema } from "./schemas.js";
import { sanitizeError, withUpdateNotice, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { resolveCourses } from "./resolve-courses.js";
import { fetchCourseAssignments } from "./get-assignments.js";
import { applyCompletions, buildContentTree, collectTopicIds, fetchRootContent } from "./get-course-content.js";
import { fetchTopicCompletions } from "./content-completion.js";
import {
  computeGradeSummary,
  renderProgressMarkdown,
  summarizeWork,
  type CourseProgress,
  type GradeCategoryDto,
  type GradeObjectDto,
  type GradeValueDto,
} from "./course-progress.js";
import { log } from "../utils/logger.js";

const refused = (error: unknown) => error instanceof ApiError && (error.status === 403 || error.status === 404);

async function gradesFor(apiClient: D2LApiClient, courseId: number): Promise<CourseProgress["grades"]> {
  const get = <T>(path: string) => apiClient.get<T>(apiClient.le(courseId, path), { ttl: DEFAULT_CACHE_TTLS.grades });
  let values: GradeValueDto[];
  try {
    values = await get<GradeValueDto[]>("/grades/values/myGradeValues/");
  } catch (error) {
    if (refused(error)) return { unavailable: "Brightspace does not let students read grades through the API for this course; check the gradebook in Brightspace." };
    throw error;
  }
  const [objects, categories, setup, final] = await Promise.all([
    get<GradeObjectDto[]>("/grades/").catch(() => [] as GradeObjectDto[]),
    get<GradeCategoryDto[]>("/grades/categories/").catch(() => [] as GradeCategoryDto[]),
    get<{ GradingSystem?: string }>("/grades/setup/").catch(() => ({} as { GradingSystem?: string })),
    get<GradeValueDto>("/grades/final/values/myGradeValue").catch(() => null),
  ]);
  const summary = computeGradeSummary(
    Array.isArray(objects) ? objects : [],
    Array.isArray(values) ? values : [],
    setup.GradingSystem ?? "Points",
    Array.isArray(categories) ? categories : []
  );
  const finalGrade = final && final.PointsNumerator !== null
    ? {
        released: true,
        displayedGrade: final.DisplayedGrade?.trim() || null,
        percent: final.PointsDenominator ? Math.round((final.PointsNumerator / final.PointsDenominator) * 1000) / 10 : null,
      }
    : { released: false };
  return { ...summary, finalGrade };
}

async function contentFor(apiClient: D2LApiClient, courseId: number): Promise<CourseProgress["content"]> {
  const root = await fetchRootContent(apiClient, courseId);
  const tree = await buildContentTree(apiClient, courseId, root, new Map(), "all");
  const { completions, source } = await fetchTopicCompletions(apiClient, courseId, collectTopicIds(tree));
  const totals = applyCompletions(tree, completions);
  return {
    ...totals,
    source,
    modules: tree
      .filter((m: any) => m.type === "module" && m.completion)
      .map((m: any) => ({ title: m.title, completed: m.completion.completed, total: m.completion.total })),
  };
}

export function registerGetCourseProgress(server: McpServer, apiClient: D2LApiClient, config: AppConfig): void {
  server.registerTool(
    "get_course_progress",
    {
      title: "Get Course Progress",
      annotations: { readOnlyHint: true },
      description:
        "A readable progress report for one course, or for every current course when courseId is omitted: the running grade computed from released grades (points or weights, matching the course's gradebook), how much of the course is graded, the final grade if released, assignments and quizzes turned in / past due / upcoming, and content topics completed per module. Use this when the user asks how they are doing, where they stand, what they still owe, or their class progress. Returns a Markdown summary first, then the JSON details. The running grade is an estimate over graded items only; say so when reporting it.",
      inputSchema: GetCourseProgressSchema,
    },
    async (args: any) => {
      try {
        const { courseId, includeContent } = GetCourseProgressSchema.parse(args);
        const courses = await resolveCourses(apiClient, config, courseId);
        // Content completion costs one request per topic, so the multi-course
        // view skips it unless asked.
        const withContent = includeContent ?? courseId !== undefined;

        const reports: CourseProgress[] = [];
        for (const course of courses) {
          const [grades, work, content] = await Promise.all([
            gradesFor(apiClient, course.id),
            fetchCourseAssignments(apiClient, course.id, config.baseUrl)
              .then((items) => summarizeWork(items))
              .catch((error): CourseProgress["work"] => {
                if (isAuthUnavailable(error)) throw error;
                log("DEBUG", `get_course_progress: assignments unavailable for ${course.id}`, error);
                return { unavailable: "Brightspace did not return this course's assignments." };
              }),
            withContent
              ? contentFor(apiClient, course.id).catch((error) => {
                  if (isAuthUnavailable(error)) throw error;
                  log("DEBUG", `get_course_progress: content unavailable for ${course.id}`, error);
                  return undefined;
                })
              : Promise.resolve(undefined),
          ]);
          reports.push({ courseId: course.id, courseName: course.name, grades, work, ...(content ? { content } : {}) });
        }

        const markdown = reports.length > 0
          ? reports.map(renderProgressMarkdown).join("\n\n")
          : "No current courses found. Pass a courseId, or use get_my_courses with term: \"all\" to find one.";
        const note = withContent || courseId !== undefined
          ? ""
          : "\n\n(Content completion skipped for the multi-course view; pass includeContent: true or a courseId to include it.)";
        return withUpdateNotice([
          { type: "text", text: markdown + note },
          { type: "text", text: JSON.stringify({ courses: reports }) },
        ]);
      } catch (error) {
        if (isAuthUnavailable(error)) {
          return withUpdateNotice([
            {
              type: "text",
              text: `Sign-in to Brightspace is still in progress, so progress could not be fetched yet. ${authPendingNotice(error)} Call get_course_progress again once sign-in finishes.`,
            },
          ]);
        }
        return sanitizeError(error);
      }
    }
  );
}

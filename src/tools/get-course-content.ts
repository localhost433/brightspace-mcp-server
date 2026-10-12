/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetCourseContentSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { matchesModifiedSince } from "../utils/modified-since.js";
import { log } from "../utils/logger.js";
import { decodeXmlEntities } from "../utils/xml-lite.js";
import { fetchTopicCompletions, type TopicCompletion } from "./content-completion.js";
import { contentAvailability, type ContentAvailability } from "./content-availability.js";

// D2L Content API response type
export interface ContentObject {
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Type: number; // 0 = Module, 1 = Topic
  Description: { Text: string; Html: string } | null;
  ModuleStartDate: string | null;
  ModuleEndDate: string | null;
  ModuleDueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  LastModifiedDate: string | null;
  // Module-specific
  Structure?: ContentObject[];
  // Topic-specific
  TopicType?: number; // 1=File, 2=Link/URL, 3=ExternalLink, etc.
  Url?: string;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  /** e.g. "https://ids.brightspace.com/activities/dropbox/<tenant>-<id>" for an assignment link. */
  ActivityId?: string | null;
  ToolItemId?: number | null;
  GradeItemId?: number | null;
}

/**
 * Course files an HTML description links to by path (a lecture table's
 * `/content/enforced/<course>/slides.pdf`), once each in order of first
 * appearance. download_file takes these as `path`.
 */
export function linkedCourseFiles(html: string | null | undefined): Array<{ title: string; path: string }> {
  const files = new Map<string, string>();
  for (const m of (html ?? "").matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeXmlEntities(m[2]).trim();
    if (!href.startsWith("/content/") || files.has(href)) continue;
    const title = decodeXmlEntities(m[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    files.set(href, title || href.split("/").pop() || href);
  }
  return [...files].map(([path, title]) => ({ title, path }));
}

/** `{ linkedFiles }` when the HTML links to course files, else nothing (absence = none). */
function linkedFilesField(html: string | null | undefined): { linkedFiles?: Array<{ title: string; path: string }> } {
  const files = linkedCourseFiles(html);
  return files.length > 0 ? { linkedFiles: files } : {};
}

/**
 * The Brightspace tool a link topic opens, read from its ActivityId (or the
 * quickLink URL's type). An assignment link's ToolItemId is the dropbox
 * folder id the assignment tools take.
 */
function linkedActivity(item: ContentObject): { kind: "assignment" | "quiz" | "discussion"; idField: string } | null {
  const source = `${item.ActivityId ?? ""} ${item.Url ?? ""}`;
  if (/activities\/dropbox\/|[?&]type=dropbox\b/i.test(source)) return { kind: "assignment", idField: "folderId" };
  if (/activities\/quiz|[?&]type=quiz\b/i.test(source)) return { kind: "quiz", idField: "quizId" };
  if (/activities\/discuss|[?&]type=discuss/i.test(source)) return { kind: "discussion", idField: "discussionTopicId" };
  return null;
}

// Progress tracking
interface ContentProgress {
  UserId: number;
  ContentObjectId: number;
  IsRead: boolean;
  DateCompleted: string | null;
}

// Topic type mapping
const TOPIC_TYPE_MAP: Record<number, string> = {
  1: 'file',
  2: 'link',
  3: 'link',  // External link
};

/**
 * Check if a content item matches the specified type filter.
 */
function matchesTypeFilter(item: ContentObject, filter: string): boolean {
  switch (filter) {
    case 'file':
      return item.TopicType === 1;
    case 'link':
      return item.TopicType === 2 || item.TopicType === 3;
    case 'html':
      return !!(item.Description?.Html) && item.TopicType !== 1;
    case 'video':
      return (item.TopicType === 2 || item.TopicType === 3) &&
        /youtube|vimeo|kaltura|video/i.test(item.Url ?? '');
    default:
      return true;
  }
}

/**
 * Fetch the root content modules for a course. Shared with search_course so
 * both tools walk the exact same tree (and share its cache entry) instead of
 * each hand-rolling the `/content/root/` call.
 */
export async function fetchRootContent(
  apiClient: D2LApiClient,
  courseId: number
): Promise<ContentObject[]> {
  return apiClient.get<ContentObject[]>(
    apiClient.le(courseId, '/content/root/'),
    { ttl: DEFAULT_CACHE_TTLS.courseContent }
  );
}

/**
 * Fetch a single module's structure, or null when the dedicated endpoint
 * fails (locked module, transient error) so the caller can fall back to
 * whatever structure the parent listing already embedded.
 */
export async function fetchModuleStructure(
  apiClient: D2LApiClient,
  courseId: number,
  moduleId: number
): Promise<ContentObject[] | null> {
  try {
    return await apiClient.get<ContentObject[]>(
      apiClient.le(courseId, `/content/modules/${moduleId}/structure/`),
      { ttl: DEFAULT_CACHE_TTLS.courseContent }
    );
  } catch (e) {
    log('DEBUG', `Failed to fetch children for module ${moduleId}: falling back to the embedded structure`);
    return null;
  }
}

/**
 * How deep the tree builder will descend when the caller names no maxDepth.
 * A module structure that lists itself is a cycle, and without a ceiling the
 * recursion would never come back.
 */
const MAX_CONTENT_DEPTH = 12;

/**
 * Availability fields are additive, matching the isHidden/isLocked convention
 * above: an available item carries none of them (absence = available), and a
 * restricted one omits startDate/endDate when there is no actual bound
 * rather than emitting a null.
 */
function availabilityFields(availability: ContentAvailability): Record<string, unknown> {
  if (availability.isAvailable) return {};
  const { isAvailable, availabilityStatus, availabilityMessage, startDate, endDate } = availability;
  return {
    isAvailable,
    availabilityStatus,
    availabilityMessage,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

/**
 * Recursively build the content tree with progress tracking.
 */
export async function buildContentTree(
  apiClient: D2LApiClient,
  courseId: number,
  modules: ContentObject[],
  progressMap: Map<number, ContentProgress>,
  typeFilter: string,
  maxDepth?: number,
  currentDepth: number = 0,
  parentAvailability?: ContentAvailability,
  now = new Date(),
): Promise<any[]> {
  const tree = [];
  const depthLimit = Math.min(maxDepth ?? MAX_CONTENT_DEPTH, MAX_CONTENT_DEPTH);

  for (const item of modules) {
    const availability = contentAvailability(item, now, parentAvailability);
    if (item.Type === 0) {
      // Module: fetch children recursively (unless the depth limit is reached)
      let processedChildren: any[] = [];

      if (currentDepth < depthLimit) {
        // The parent listing already embeds this module's immediate children
        // in Structure. The dedicated endpoint is still asked first because it
        // is the authoritative copy, but a module whose structure call fails —
        // or answers with something that is not an array — must fall back to
        // what the parent already handed us. Falling through to an empty list
        // made a locked or erroring module look like an empty one, and under a
        // typeFilter it dropped the module from the tree with no trace.
        let children = await fetchModuleStructure(apiClient, courseId, item.Id);

        if (!Array.isArray(children)) {
          children = Array.isArray(item.Structure) ? item.Structure : [];
        }

        processedChildren = await buildContentTree(
          apiClient, courseId, children, progressMap, typeFilter, maxDepth, currentDepth + 1, availability, now
        );
      } else if (currentDepth >= MAX_CONTENT_DEPTH) {
        log('DEBUG', `Content depth ceiling of ${MAX_CONTENT_DEPTH} reached at module ${item.Id}: not descending further`);
      }

      // Only include module if it has matching children (or filter is 'all')
      if (typeFilter === 'all' || processedChildren.length > 0) {
        tree.push({
          type: 'module',
          id: item.Id,
          title: item.Title,
          description: item.Description?.Html?.trim()
            ? convertHtmlToMarkdown(item.Description.Html).markdown
            : item.Description?.Text ?? null,
          ...(item.ModuleDueDate ? { dueDate: item.ModuleDueDate } : {}),
          ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
          ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
          ...availabilityFields(availability),
          lastModified: item.LastModifiedDate ?? null,
          ...linkedFilesField(item.Description?.Html),
          children: processedChildren,
        });
      }
    } else if (item.Type === 1) {
      // Topic — process based on TopicType
      const topicType = TOPIC_TYPE_MAP[item.TopicType ?? 0] ?? 'other';

      // Apply type filter
      if (typeFilter !== 'all' && !matchesTypeFilter(item, typeFilter)) {
        continue;
      }

      const topicProgress = progressMap.get(item.Id);

      const topic: any = {
        type: 'topic',
        topicType,
        id: item.Id,
        title: item.Title,
        ...(item.IsHidden ? { isHidden: item.IsHidden } : {}),
        ...(item.IsLocked ? { isLocked: item.IsLocked } : {}),
        ...availabilityFields(availability),
        ...(item.DueDate ? { dueDate: item.DueDate } : {}),
        lastModified: item.LastModifiedDate ?? null,
        isCompleted: topicProgress?.IsRead ?? false,
        ...(topicProgress?.DateCompleted ? { completedDate: topicProgress.DateCompleted } : {}),
      };

      // Add type-specific content
      if (item.TopicType === 1) {
        // File topic — include description
        topic.description = item.Description?.Text ?? null;
        topic.topicId = item.Id; // Useful for download_file tool
      } else if (item.TopicType === 2 || item.TopicType === 3) {
        // Link topic — include URL
        topic.url = item.Url ?? null;
        // A link into a Brightspace tool says which one, with the id the
        // matching tools take (folderId for get_assignment_files and friends).
        const activity = linkedActivity(item);
        if (activity) {
          topic.linksTo = activity.kind;
          if (typeof item.ToolItemId === "number") topic[activity.idField] = item.ToolItemId;
        }
      }

      // HTML content — include body converted to markdown
      if (item.Description?.Html) {
        topic.content = convertHtmlToMarkdown(item.Description.Html).markdown;
        Object.assign(topic, linkedFilesField(item.Description.Html));
      }

      tree.push(topic);
    }
  }

  return tree;
}

/**
 * Filter a content tree to items modified at or after cutoff.
 *
 * A module is kept when its own timestamp matches OR any descendant matched
 * (even with zero matching children after recursion) — a matched topic with
 * no surrounding module would be a result with no context, which is the
 * failure mode #34 called out.
 */
function filterTreeByModifiedSince(tree: any[], cutoff: Date): any[] {
  const result: any[] = [];
  for (const item of tree) {
    if (item.type === 'topic') {
      if (matchesModifiedSince(item.lastModified, cutoff)) {
        result.push(item);
      }
    } else if (item.type === 'module') {
      const filteredChildren = filterTreeByModifiedSince(item.children ?? [], cutoff);
      const moduleMatches = matchesModifiedSince(item.lastModified, cutoff);
      if (moduleMatches || filteredChildren.length > 0) {
        result.push({ ...item, children: filteredChildren });
      }
    }
  }
  return result;
}

/** Every topic id in a built tree, in order. */
export function collectTopicIds(tree: any[]): number[] {
  const ids: number[] = [];
  for (const item of tree) {
    if (item.type === 'topic') ids.push(item.id);
    else if (item.type === 'module') ids.push(...collectTopicIds(item.children ?? []));
  }
  return ids;
}

/**
 * Mark each topic's completion and give each module a completed/total count
 * of the topics beneath it. Returns the totals for the whole tree.
 */
export function applyCompletions(
  tree: any[],
  completions: Map<number, TopicCompletion>
): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const item of tree) {
    if (item.type === 'topic') {
      const c = completions.get(item.id);
      item.isCompleted = c?.completed ?? false;
      if (c?.completedDate) item.completedDate = c.completedDate;
      total++;
      if (item.isCompleted) completed++;
    } else if (item.type === 'module') {
      const sub = applyCompletions(item.children ?? [], completions);
      if (sub.total > 0) item.completion = sub;
      completed += sub.completed;
      total += sub.total;
    }
  }
  return { completed, total };
}

/**
 * Count total topics in tree (for summary stats).
 */
function countTopics(tree: any[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === 'topic') {
      count++;
    } else if (item.type === 'module' && item.children) {
      count += countTopics(item.children);
    }
  }
  return count;
}

/**
 * Count total modules in tree (for summary stats).
 */
function countModules(tree: any[]): number {
  let count = 0;
  for (const item of tree) {
    if (item.type === 'module') {
      count++;
      if (item.children) {
        count += countModules(item.children);
      }
    }
  }
  return count;
}

/**
 * Register get_course_content tool
 */
export function registerGetCourseContent(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_course_content",
    {
      title: "Get Course Content",
      annotations: { readOnlyHint: true },
      description:
        "Fetch the content tree for a course showing modules, topics, files, and links. Use this when the user asks about course materials, lecture slides, uploaded files, content structure, or what's in a course module. Use moduleTitle to filter to a specific module (e.g. 'Labs', 'Staff', 'Homeworks') instead of fetching the entire tree. Use maxDepth to limit recursion depth for a table-of-contents view. A module or topic that isn't currently available carries isAvailable/availabilityStatus/availabilityMessage (and startDate/endDate when known) explaining why; absence of these fields means it's available now. A link topic that opens an assignment, quiz or discussion carries linksTo plus its id (folderId for assignments, usable with get_assignment_files and download_file). A module or topic whose description links to course files (e.g. a lecture schedule table linking slide PDFs) lists them under linkedFiles; pass a linkedFiles path to download_file as path to read one. Each topic's isCompleted reflects your own completion; modules carry a completion {completed, total} count.",
      inputSchema: GetCourseContentSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_course_content tool called", { args });

        // Parse and validate input
        const { courseId, typeFilter = 'all', moduleTitle, maxDepth, modifiedSince } = GetCourseContentSchema.parse(args);

        // Fetch root modules
        let rootModules = await fetchRootContent(apiClient, courseId);

        // Filter root modules by title if specified
        if (moduleTitle) {
          const searchTerm = moduleTitle.toLowerCase();
          rootModules = rootModules.filter(m =>
            m.Title.toLowerCase().includes(searchTerm)
          );
        }

        // Build the tree first; completion is looked up afterwards for just
        // the topics it ended up containing.
        let contentTree = await buildContentTree(
          apiClient,
          courseId,
          rootModules,
          new Map(),
          typeFilter,
          maxDepth
        );

        // Apply modifiedSince filter, if requested, after the tree is built:
        // a module's own timestamp may not change when a child topic does, so
        // filtering has to see the whole tree to know which modules to keep.
        let filteredOut = 0;
        if (modifiedSince) {
          const topicCountBeforeFilter = countTopics(contentTree);
          const cutoff = new Date(modifiedSince);
          contentTree = filterTreeByModifiedSince(contentTree, cutoff);
          filteredOut = topicCountBeforeFilter - countTopics(contentTree);
        }

        const { completions, source: completionSource } = await fetchTopicCompletions(
          apiClient,
          courseId,
          collectTopicIds(contentTree)
        );
        const completion = applyCompletions(contentTree, completions);

        const topicCount = countTopics(contentTree);
        const moduleCount = countModules(contentTree);

        log("INFO", `get_course_content: Retrieved ${moduleCount} modules and ${topicCount} topics for course ${courseId} (filter: ${typeFilter})`);

        return toolResponse({
          courseId,
          typeFilter,
          contentTree,
          topicCount,
          moduleCount,
          completedTopicCount: completion.completed,
          completionSource,
          ...(completionSource === "unavailable"
            ? { completionNote: "Brightspace refused every completion lookup for this course, so isCompleted is unknown (reported as false), not a measurement." }
            : {}),
          ...(modifiedSince ? { modifiedSince, returned: topicCount, filteredOut } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

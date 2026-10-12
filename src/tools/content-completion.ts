/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { log } from "../utils/logger.js";

export interface TopicCompletion {
  completed: boolean;
  completedDate?: string;
}

/**
 * Where completion data came from: the bulk user-progress route, one
 * completions call per topic, or nowhere (every route refused).
 */
export type CompletionSource = "userprogress" | "topicCompletions" | "unavailable";

export interface CompletionLookup {
  completions: Map<number, TopicCompletion>;
  source: CompletionSource;
}

/** Per-topic completion lookups in flight at once. */
const COMPLETION_FETCH_CONCURRENCY = 6;

interface ProgressRow {
  ObjectId?: number;
  ContentObjectId?: number;
  TopicId?: number;
  IsRead?: boolean;
  DateCompleted?: string | null;
  CompletedDate?: string | null;
  CompletionDate?: string | null;
}

interface CompletionRow {
  UserId: number;
  TopicId: number;
  CompletionDate?: string | null;
}

function fromProgressRow(row: ProgressRow): [number, TopicCompletion] | null {
  const id = row.ContentObjectId ?? row.ObjectId ?? row.TopicId;
  if (typeof id !== "number") return null;
  const date = row.DateCompleted ?? row.CompletedDate ?? row.CompletionDate ?? undefined;
  return [id, { completed: row.IsRead === true || Boolean(date), ...(date ? { completedDate: date } : {}) }];
}

/**
 * Which of a course's topics the signed-in user has completed.
 *
 * The bulk /content/userprogress/ route is asked first, but some tenants
 * (NYU among them) answer it with 404, which used to leave every topic
 * reported as incomplete. When it is refused or comes back empty, this asks
 * /content/topics/{id}/completions/ for each topic instead, keeping only the
 * signed-in user's row so an instructor's view of everyone cannot leak in.
 */
export async function fetchTopicCompletions(
  apiClient: D2LApiClient,
  courseId: number,
  topicIds: number[]
): Promise<CompletionLookup> {
  const completions = new Map<number, TopicCompletion>();

  try {
    const response = await apiClient.get<ProgressRow[] | { Objects?: ProgressRow[] }>(
      apiClient.le(courseId, "/content/userprogress/"),
      { ttl: DEFAULT_CACHE_TTLS.courseContent }
    );
    const rows = Array.isArray(response) ? response : response?.Objects ?? [];
    for (const row of rows) {
      const entry = fromProgressRow(row);
      if (entry) completions.set(...entry);
    }
    if (completions.size > 0) return { completions, source: "userprogress" };
  } catch (error) {
    log("DEBUG", `content completion: userprogress unavailable for course ${courseId}`, error);
  }

  if (topicIds.length === 0) return { completions, source: "topicCompletions" };

  let myId: number;
  try {
    const me = await apiClient.get<{ Identifier: number | string }>(apiClient.lp("/users/whoami"), {
      ttl: DEFAULT_CACHE_TTLS.profile,
    });
    myId = Number(me.Identifier);
    if (!Number.isSafeInteger(myId)) return { completions, source: "unavailable" };
  } catch (error) {
    log("DEBUG", "content completion: whoami unavailable", error);
    return { completions, source: "unavailable" };
  }

  let answered = 0;
  await mapWithConcurrency(topicIds, COMPLETION_FETCH_CONCURRENCY, async (topicId) => {
    try {
      const rows = await fetchAllObjects<CompletionRow>(
        apiClient,
        apiClient.le(courseId, `/content/topics/${topicId}/completions/`),
        { ttl: DEFAULT_CACHE_TTLS.courseContent }
      );
      answered++;
      const mine = rows.find((r) => Number(r.UserId) === myId);
      completions.set(
        topicId,
        mine ? { completed: true, ...(mine.CompletionDate ? { completedDate: mine.CompletionDate } : {}) } : { completed: false }
      );
    } catch (error) {
      log("DEBUG", `content completion: topic ${topicId} completions unavailable`, error);
    }
  });

  return { completions, source: answered > 0 ? "topicCompletions" : "unavailable" };
}

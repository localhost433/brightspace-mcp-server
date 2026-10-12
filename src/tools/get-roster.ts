/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import {
  GetRosterSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

export interface ClasslistUser {
  // D2L returns this as a string on real tenants even though it is
  // numeric-looking; callers that need to match it against a numeric id
  // (e.g. get_my_groups resolving Enrollments) must coerce with Number().
  Identifier: number | string;
  DisplayName: string;
  Email: string | null;
  FirstName: string | null;
  LastName: string | null;
  RoleId: number | null;
  ClasslistRoleDisplayName: string;
  IsOnline: boolean;
  LastAccessed: string | null;
  Username?: string | null;
  Pronouns?: string | null;
}

// Staff role IDs are tenant-specific. 109 is Instructor at both NYU and
// Purdue; Teaching Assistant is 114 at NYU and 135 at Purdue. Discover others
// by fetching a classlist and inspecting RoleId values.
const STAFF_ROLE_IDS = new Set([109, 114, 135]);

// Staff are also recognized by the role name the tenant reports, which
// covers roles with no fixed ID (NYU's "Non-Grading Course Assistant" has a
// null RoleId). Role-name matching adapted from
// matthewliu10/brightspace-mcp-server (MIT).
const TEACHING_ROLE_NAME =
  /\b(instructor|professor|lecturer|teaching assistant|course assistant|learning assistant|coordinator|grader|ta)\b/i;

function isStaff(user: ClasslistUser): boolean {
  return (user.RoleId !== null && STAFF_ROLE_IDS.has(Number(user.RoleId)))
    || TEACHING_ROLE_NAME.test(user.ClasslistRoleDisplayName ?? "");
}

interface SectionDto {
  SectionId: number;
  Name: string;
  Code: string;
  Enrollments?: number[] | null;
}

/** The course's sections, or null when the student API withholds them. */
async function fetchSections(apiClient: D2LApiClient, courseId: number): Promise<SectionDto[] | null> {
  try {
    const sections = await apiClient.get<SectionDto[]>(apiClient.lp(`/${courseId}/sections/`), {
      ttl: DEFAULT_CACHE_TTLS.roster,
    });
    return Array.isArray(sections) ? sections : null;
  } catch (error) {
    log("DEBUG", `get_roster: sections unavailable for course ${courseId}`, error);
    return null;
  }
}

async function fetchMyId(apiClient: D2LApiClient): Promise<number | null> {
  try {
    const me = await apiClient.get<{ Identifier: number | string }>(apiClient.lp("/users/whoami"), {
      ttl: DEFAULT_CACHE_TTLS.profile,
    });
    const id = Number(me.Identifier);
    return Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Fetch every classlist user matching the optional filters, across all pages.
 *
 * Exported so other tools that need names for a course's enrolled users
 * (e.g. get_my_groups resolving group membership) can reuse this instead of
 * re-implementing the paged classlist fetch.
 */
export async function fetchClasslistUsers(
  apiClient: D2LApiClient,
  courseId: number,
  options?: { roleId?: number; searchTerm?: string }
): Promise<ClasslistUser[]> {
  const params = new URLSearchParams();

  if (options?.roleId !== undefined) {
    params.append("roleId", options.roleId.toString());
  }

  if (options?.searchTerm) {
    params.append("searchTerm", options.searchTerm);
  }

  const queryString = params.toString();
  const path = apiClient.le(
    courseId,
    `/classlist/paged/${queryString ? "?" + queryString : ""}`
  );

  return fetchAllObjects<ClasslistUser>(apiClient, path, {
    ttl: DEFAULT_CACHE_TTLS.roster,
  });
}

/**
 * Register get_roster tool
 */
export function registerGetRoster(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_roster",
    {
      title: "Get Course Roster",
      annotations: { readOnlyHint: true },
      description:
        "Fetch the roster for a course including instructors, TAs, course assistants, and optionally students with their names, emails, roles, usernames (NetIDs), pronouns and sections. Also lists the course's sections with sizes and which section(s) you are in (mySections). Use this when the user asks about classmates, instructor contact info, TA emails, professor names, recitation sections, or who's in a class. By default returns only staff for privacy. Use includeStudents to get the full class list, and section to narrow to one section.",
      inputSchema: GetRosterSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_roster tool called", { args });

        // Parse and validate input
        const { courseId, includeStudents, searchTerm, section, limit } = GetRosterSchema.parse(args);

        try {
          // One classlist read serves both views. Staff are picked out by role
          // ID or role name rather than by per-role queries, because some
          // staff roles (NYU's course assistants) have no role ID to query.
          // A failure here surfaces as a tool error (or authPending below)
          // rather than an empty list.
          const [everyone, sections, myId] = await Promise.all([
            fetchClasslistUsers(apiClient, courseId, { searchTerm }),
            fetchSections(apiClient, courseId),
            fetchMyId(apiClient),
          ]);

          const sectionsByUser = new Map<number, string[]>();
          for (const section of sections ?? []) {
            for (const id of section.Enrollments ?? []) {
              sectionsByUser.set(id, [...(sectionsByUser.get(id) ?? []), section.Name]);
            }
          }

          let selected = includeStudents ? everyone : everyone.filter(isStaff);
          if (section) {
            const wanted = section.toLowerCase();
            selected = selected.filter((u) =>
              (sectionsByUser.get(Number(u.Identifier)) ?? []).some((n) => n.toLowerCase().includes(wanted))
            );
          }

          // A very large roster would swamp the response, so it is capped. The
          // cap is reported in the payload rather than only in a log line the
          // model never sees: a 340 person lecture used to look like a 100
          // person one, with nothing to say otherwise.
          const total = selected.length;
          const truncated = total > limit;
          const kept = truncated ? selected.slice(0, limit) : selected;

          if (truncated) {
            log("WARN", "get_roster: Result set exceeds the limit, truncating", {
              total,
              returned: kept.length,
            });
          }

          const users = kept.map((user) => {
            const userSections = sectionsByUser.get(Number(user.Identifier));
            return {
              name: user.DisplayName,
              email: user.Email || null,
              role: user.ClasslistRoleDisplayName,
              ...(user.Username ? { username: user.Username } : {}),
              ...(user.Pronouns ? { pronouns: user.Pronouns } : {}),
              ...(userSections ? { sections: userSections } : {}),
            };
          });

          const mySections = myId !== null ? sectionsByUser.get(myId) : undefined;

          log("INFO", `get_roster: Retrieved ${users.length} users for course ${courseId}`);
          return toolResponse({
            courseId,
            total,
            returned: users.length,
            truncated,
            ...(truncated
              ? { note: `Showing ${users.length} of ${total}. Raise the limit argument to see more.` }
              : {}),
            ...(sections
              ? {
                  sections: sections.map((s) => ({ name: s.Name, code: s.Code, size: s.Enrollments?.length ?? null })),
                  ...(mySections ? { mySections } : {}),
                }
              : {}),
            users,
          });
        } catch (error) {
          // A pending sign-in is not an empty roster: the route never
          // answered, so the result says so instead of reporting zero users
          // as if that were a real measurement. The envelope stays a success
          // — existing callers that only read `users` keep working — with
          // authPending/notice added for callers that want to tell "empty
          // roster" apart from "couldn't check".
          if (isAuthUnavailable(error)) {
            log("DEBUG", `get_roster: sign-in pending for course ${courseId}`, error);
            return toolResponse({
              courseId,
              total: 0,
              returned: 0,
              truncated: false,
              users: [],
              authPending: true,
              notice:
                "Sign-in to Brightspace is still in progress, so the roster for this course " +
                `could not be fetched yet. ${authPendingNotice(error)} Call get_roster again once ` +
                "sign-in finishes.",
            });
          }
          throw error;
        }
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

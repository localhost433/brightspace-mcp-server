import { describe, it, expect, vi } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";

/**
 * The roster reads the same paged classlist endpoint, so it dropped users past
 * the first page too. A full class can easily outrun one page.
 *
 * It also capped the result at 100 users and said so only in a log line the
 * model never sees, so a 340 person lecture looked like a 100 person one. The
 * cap is still there, because an enormous roster would swamp the response, but
 * it is now reported in the payload and the caller can raise it.
 */

const COURSE_ID = 101;

const user = (name: string) => ({
  Identifier: name.length,
  DisplayName: name,
  Email: `${name}@example.edu`,
  FirstName: name,
  LastName: null,
  RoleId: null,
  ClasslistRoleDisplayName: "Student",
  IsOnline: false,
  LastAccessed: null,
});

function setup(respond: (path: string) => unknown) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetRoster(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_roster pagination", () => {
  it("returns students across both pages", async () => {
    const { call, requested } = setup((path) =>
      path.includes("bookmark=b1")
        ? { Objects: [user("grace")], Next: null }
        : { Objects: [user("ada")], Next: "b1" }
    );

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });
});

describe("get_roster truncation", () => {
  const manyUsers = (count: number) =>
    Array.from({ length: count }, (_, i) => user(`student${i}`));

  it("reports the total and the truncation rather than hiding it", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.total).toBe(340);
    expect(payload.returned).toBe(100);
    expect(payload.truncated).toBe(true);
    expect(payload.users).toHaveLength(100);
    expect(payload.note).toMatch(/limit/i);
  });

  it("is not truncated when the class fits", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(12), Next: null }));

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.total).toBe(12);
    expect(payload.returned).toBe(12);
    expect(payload.truncated).toBe(false);
    expect(payload.note).toBeUndefined();
  });

  it("honors an explicit limit", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const payload = parse(
      await call({ courseId: COURSE_ID, includeStudents: true, limit: 250 })
    );

    expect(payload.returned).toBe(250);
    expect(payload.truncated).toBe(true);
  });
});

/**
 * A sign-in that has not finished is not an empty roster. CLAUDE.md forbids
 * turning a previously successful `{users: []}` response into an error, so
 * the tool keeps the success envelope and adds an explicit authPending/notice
 * pair a caller can check instead.
 */

import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { ApiError } from "../../src/api/errors.js";

const mfaPending = () => new AuthProcessError("mfaPending", "MFA approval pending");

describe("get_roster while sign-in is pending", () => {
  it("reports authPending instead of an empty list read as success (includeStudents)", async () => {
    const { call } = setup(() => {
      throw mfaPending();
    });

    const result = await call({ courseId: COURSE_ID, includeStudents: true });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed).toMatchObject({ courseId: COURSE_ID, users: [], authPending: true });
    expect(parsed.notice).toContain("Approve the sign-in request");
  });

  it("reports authPending for the default staff view too", async () => {
    const { call } = setup(() => {
      throw mfaPending();
    });

    const parsed = parse(await call({ courseId: COURSE_ID }));

    expect(parsed).toMatchObject({ users: [], authPending: true });
  });
});

/**
 * Staff are picked out of one classlist read by role ID (109 Instructor;
 * 114 NYU / 135 Purdue Teaching Assistant) or by role name. Per-role queries
 * cannot find NYU's "Non-Grading Course Assistant", whose RoleId is null.
 */
describe("get_roster staff selection", () => {
  const staffUser = (name: string, roleId: number | null, role: string | null) => ({
    ...user(name),
    RoleId: roleId,
    ClasslistRoleDisplayName: role,
  });

  const classlist = (...users: unknown[]) => () => ({ Objects: users, Next: null });

  it("finds staff by NYU and Purdue role IDs and by role name, excluding students", async () => {
    const { call } = setup(
      classlist(
        staffUser("prof", 109, "Instructor"),
        staffUser("nyu-ta", 114, "Teaching Assistant"),
        staffUser("purdue-ta", 135, "TA"),
        staffUser("assistant", null, "Non-Grading Course Assistant"),
        staffUser("admin", 126, "Course Admin (Albert)"),
        staffUser("learner", 110, "Student")
      )
    );

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["prof", "nyu-ta", "purdue-ta", "assistant"]);
  });

  it("excludes a user with a null role display name and no staff role ID", async () => {
    const { call } = setup(classlist(staffUser("prof", 501, "Instructor"), staffUser("mystery", null, null)));

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["prof"]);
  });

  it("matches Course Coordinator and Grader by name", async () => {
    const { call } = setup(
      classlist(staffUser("coord", 601, "Course Coordinator"), staffUser("grader", 602, "Grader"), staffUser("learner", 110, "Student"))
    );

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["coord", "grader"]);
  });

  it("reports a classlist error instead of returning an empty staff list", async () => {
    const { call } = setup(() => {
      throw new Error("classlist unavailable");
    });

    expect((await call({ courseId: COURSE_ID })).isError).toBe(true);
  });
});

describe("get_roster sections", () => {
  function setupWithSections() {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      lp: (p: string) => `/d2l/api/lp/1.0${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/users/whoami")) return { Identifier: "3" };
        if (path.endsWith("/sections/")) {
          return [
            { SectionId: 1, Name: "Lecture 001", Code: "L001", Enrollments: [3, 4, 9] },
            { SectionId: 2, Name: "Recitation 002", Code: "R002", Enrollments: [3, 9] },
          ];
        }
        return {
          Objects: [
            { ...user("ada"), Identifier: "3", Username: "ada1", Pronouns: "she/her" },
            { ...user("bob"), Identifier: "4" },
            { ...user("prof"), Identifier: "9", RoleId: 109, ClasslistRoleDisplayName: "Instructor" },
          ],
          Next: null,
        };
      }),
    };
    let handler: (args: unknown) => Promise<any>;
    registerGetRoster({ registerTool: (_n: string, _m: unknown, fn: any) => { handler = fn; } } as any, apiClient as any);
    return (args: unknown) => handler!(args);
  }

  it("tags each person with their sections and lists mine", async () => {
    const payload = parse(await setupWithSections()({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.sections).toEqual([
      { name: "Lecture 001", code: "L001", size: 3 },
      { name: "Recitation 002", code: "R002", size: 2 },
    ]);
    expect(payload.mySections).toEqual(["Lecture 001", "Recitation 002"]);
    expect(payload.users[0]).toEqual({
      name: "ada", email: "ada@example.edu", role: "Student", username: "ada1", pronouns: "she/her",
      sections: ["Lecture 001", "Recitation 002"],
    });
  });

  it("narrows to one section", async () => {
    const payload = parse(await setupWithSections()({ courseId: COURSE_ID, includeStudents: true, section: "002" }));

    expect(payload.users.map((u: any) => u.name)).toEqual(["ada", "prof"]);
  });
});

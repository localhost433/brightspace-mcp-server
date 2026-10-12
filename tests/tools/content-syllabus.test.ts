import { describe, it, expect, vi } from "vitest";
import { findContentSyllabus } from "../../src/tools/content-syllabus.js";

/**
 * NYU courses leave the Overview empty and post the syllabus as course
 * content: a file topic named "syllabus", or a "Syllabus" module holding a
 * link. get_syllabus reported "No syllabus found" for all of them.
 */

const topic = (Id: number, Title: string, TopicType: number, extra: Record<string, unknown> = {}) => ({
  Id, Title, ShortTitle: "", Type: 1, TopicType, Description: null, IsHidden: false, IsLocked: false,
  DueDate: null, LastModifiedDate: null, ...extra,
});
const module = (Id: number, Title: string, Structure: unknown[]) => ({
  Id, Title, ShortTitle: "", Type: 0, Description: null, ModuleStartDate: null, ModuleEndDate: null,
  ModuleDueDate: null, IsHidden: false, IsLocked: false, LastModifiedDate: null, Structure,
});

function client(root: unknown[], file?: Buffer, news: unknown[] = []) {
  return {
    le: (ou: number, p: string) => `/d2l/api/le/1.0/${ou}${p}`,
    get: vi.fn(async (p: string) => {
      if (p.endsWith("/content/root/")) return root;
      if (p.endsWith("/news/")) return news;
      const m = /\/content\/modules\/(\d+)\/structure\/$/.exec(p);
      if (m) return (root as any[]).find((x) => x.Id === Number(m[1]))?.Structure ?? [];
      return [];
    }),
    getRaw: vi.fn(async () => new Response(file ? new Uint8Array(file) : null, { status: 200 })),
  };
}

describe("findContentSyllabus", () => {
  it("reads a file topic titled syllabus", async () => {
    const api = client(
      [module(1, "Syllabus & General Course Info", [topic(11, "syllabus", 1), topic(12, "Office Hours", 1)])],
      Buffer.from("Grading: homework 30%, midterm 30%, final 40%")
    );

    const found = await findContentSyllabus(api as any, 101);

    expect(api.getRaw).toHaveBeenCalledWith("/d2l/api/le/1.0/101/content/topics/11/file");
    expect(found?.source).toEqual({ title: "syllabus", topicId: 11, kind: "file", module: "Syllabus & General Course Info" });
    expect(found?.text).toContain("final 40%");
  });

  it("reports a link topic inside a Syllabus module without fetching it", async () => {
    const api = client([module(1, "Syllabus", [topic(21, "Fall 2026: CSCI-UA 473", 3, { Url: "https://docs.google.com/document/d/abc/edit" })])]);

    const found = await findContentSyllabus(api as any, 101, { fetchImpl: vi.fn(async () => new Response("", { status: 403 })) as any });

    expect(found?.source).toMatchObject({ topicId: 21, kind: "link", url: "https://docs.google.com/document/d/abc/edit" });
    expect(found?.text).toBeUndefined();
  });

  it("reads a public Google Doc syllabus through its plain-text export", async () => {
    const api = client([module(1, "Syllabus", [topic(21, "Syllabus doc", 3, { Url: "https://docs.google.com/document/d/abc123/edit?usp=drivesdk" })])]);
    const fetchImpl = vi.fn(async () => new Response("Course policies...", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));

    const found = await findContentSyllabus(api as any, 101, { fetchImpl: fetchImpl as any });

    expect(fetchImpl).toHaveBeenCalledWith("https://docs.google.com/document/d/abc123/export?format=txt", expect.anything());
    expect(found?.text).toBe("Course policies...");
  });

  it("uses the description of a Syllabus module that has no topics", async () => {
    const api = client([
      { ...module(1, "Syllabus", []), Description: { Text: "", Html: "<p><strong>MATH-UA 343: Algebra</strong><br>Lectures: Tuesday and Thursday</p>" } },
    ]);

    const found = await findContentSyllabus(api as any, 101);

    expect(found?.source).toEqual({ title: "Syllabus", moduleId: 1, kind: "module" });
    expect(found?.text).toContain("MATH-UA 343: Algebra");
  });

  it("falls back to a syllabus link in an announcement", async () => {
    const api = client([], undefined, [
      { Id: 9, Title: "Welcome", Body: { Text: "Zoom: https://nyu.zoom.us/j/1\r\nSyllabus: https://knowledge.kitchen/courses/agile/syllabus/\r\nDiscord: https://discord.gg/x", Html: "" } },
    ]);

    const found = await findContentSyllabus(api as any, 101);

    expect(found?.source).toEqual({ title: "Welcome", announcementId: 9, kind: "announcementLink", url: "https://knowledge.kitchen/courses/agile/syllabus/" });
  });

  it("returns null when nothing in the content is a syllabus", async () => {
    const api = client([module(1, "Lectures", [topic(31, "Week 1", 1)])]);

    expect(await findContentSyllabus(api as any, 101)).toBeNull();
  });
});

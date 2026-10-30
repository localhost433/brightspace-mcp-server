import { describe, expect, it } from "vitest";
import { parseCoursePath } from "../../src/utils/course-files.js";

const ORIGIN = "https://brightspace.example";

describe("enforced course-file raw authorities", () => {
  it.each([
    `${ORIGIN}\\shadow/content/enforced/tenant-folder/a.pdf`,
    `${ORIGIN}\t/content/enforced/tenant-folder/a.pdf`,
    `${ORIGIN}\n/content/enforced/tenant-folder/a.pdf`,
    `${ORIGIN}\r/content/enforced/tenant-folder/a.pdf`,
    `${ORIGIN}?next=/content/enforced/tenant-folder/a.pdf`,
    `${ORIGIN}#next/content/enforced/tenant-folder/a.pdf`,
    "https:///brightspace.example/content/enforced/tenant-folder/a.pdf",
  ])("rejects malformed authority/path boundaries: %s", (input) => {
    expect(parseCoursePath(input, 101, ORIGIN)).toHaveProperty("error");
  });

  it.each([
    `${ORIGIN}/content/enforced/101-course/Notes/a.pdf`,
    `${ORIGIN}/content/enforced/101-course/Notes/a.pdf?download=1`,
    `${ORIGIN}/content/enforced/101-course/Notes/a.pdf#page=2`,
    "https://brightspace.example:443/content/enforced/101-course/Notes/a.pdf",
  ])("preserves valid same-origin links: %s", (input) => {
    expect(parseCoursePath(input, 101, ORIGIN)).toBe("Notes/a.pdf");
  });

  it.each([
    `${ORIGIN}/content/enforced/101-course/csfiles\\home_dir\\notes.pdf`,
    "/content/enforced/101-course/csfiles\\home_dir\\notes.pdf",
  ])("preserves legacy backslash path separators: %s", (input) => {
    expect(parseCoursePath(input, 101, ORIGIN)).toBe(
      "csfiles/home_dir/notes.pdf",
    );
  });

  it.each([
    "https://elsewhere.example/content/enforced/101-course/a.pdf",
    "https://user:pass@brightspace.example/content/enforced/101-course/a.pdf",
    `${ORIGIN}/content/enforced/102-course/a.pdf`,
    `${ORIGIN}/content/enforced/101-course/../a.pdf`,
    `${ORIGIN}/content/enforced/101-course/%2e%2e/a.pdf`,
  ])("keeps existing origin and course boundaries: %s", (input) => {
    expect(parseCoursePath(input, 101, ORIGIN)).toHaveProperty("error");
  });
});

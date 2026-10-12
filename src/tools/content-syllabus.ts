/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { buildContentTree, fetchRootContent } from "./get-course-content.js";
import { readBodyCapped } from "../utils/download-helpers.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { documentTextForName } from "../utils/archive-text.js";
import { log } from "../utils/logger.js";

export interface ContentSyllabusSource {
  title: string;
  /** file/link/html: a content topic; module: a Syllabus module's own text; announcementLink: a link posted in an announcement. */
  kind: "file" | "link" | "html" | "module" | "announcementLink";
  topicId?: number;
  moduleId?: number;
  announcementId?: number;
  module?: string;
  url?: string;
}

export interface ContentSyllabus {
  source: ContentSyllabusSource;
  /** Extracted text, when the source could be read. */
  text?: string;
  /** Other syllabus-looking topics, for the caller to offer. */
  otherCandidates?: ContentSyllabusSource[];
}

const SYLLABUS = /syllabus/i;
/** How deep to walk the content tree; syllabi sit at the top of a course. */
const SEARCH_DEPTH = 2;

/**
 * Find the syllabus in a course's content when the Overview is empty, as it
 * is across NYU: a topic titled "syllabus" anywhere near the top, or the
 * topics inside (or the description of) a module titled "Syllabus", and
 * failing that a syllabus link in an announcement. The best candidate's text is
 * read when possible: a file topic is downloaded and extracted, an HTML
 * topic's body is used, and a public Google Doc is read through its
 * plain-text export (no credentials are sent). Returns null when nothing
 * looks like a syllabus.
 */
export async function findContentSyllabus(
  apiClient: D2LApiClient,
  courseId: number,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<ContentSyllabus | null> {
  const root = await fetchRootContent(apiClient, courseId);
  const tree = await buildContentTree(apiClient, courseId, root, new Map(), "all", SEARCH_DEPTH);

  const titled: Array<ContentSyllabusSource & { content?: string }> = [];
  const moduleTexts: Array<ContentSyllabusSource & { content?: string }> = [];
  const inModule: Array<ContentSyllabusSource & { content?: string }> = [];
  const walk = (nodes: any[], moduleTitle: string | undefined, inSyllabusModule: boolean) => {
    for (const node of nodes) {
      if (node.type === "module") {
        // A Syllabus module may carry the syllabus as its own description.
        if (SYLLABUS.test(node.title) && typeof node.description === "string" && node.description.trim()) {
          moduleTexts.push({ title: node.title, moduleId: node.id, kind: "module", content: node.description });
        }
        walk(node.children ?? [], node.title, inSyllabusModule || SYLLABUS.test(node.title));
      } else if (node.type === "topic") {
        const source = {
          title: node.title,
          topicId: node.id,
          kind: (node.topicType === "file" ? "file" : node.topicType === "link" ? "link" : "html") as ContentSyllabusSource["kind"],
          ...(moduleTitle ? { module: moduleTitle } : {}),
          ...(node.url ? { url: node.url } : {}),
          ...(node.content ? { content: node.content } : {}),
        };
        if (SYLLABUS.test(node.title)) titled.push(source);
        else if (inSyllabusModule) inModule.push(source);
      }
    }
  };
  walk(tree, undefined, false);

  const candidates = [...titled, ...moduleTexts, ...inModule];
  if (candidates.length === 0) return findAnnouncedSyllabus(apiClient, courseId);
  const [best, ...rest] = candidates;
  const { content, ...source } = best;

  let text: string | undefined;
  try {
    if (best.kind === "file") {
      const response = await apiClient.getRaw(apiClient.le(courseId, `/content/topics/${best.topicId!}/file`));
      const buffer = await readBodyCapped(response, MAX_FILE_SIZE);
      text = (await documentTextForName(guessName(best.title, buffer), buffer)) ?? undefined;
    } else if (content) {
      text = content;
    } else if (best.url) {
      text = await readPublicGoogleDoc(best.url, deps.fetchImpl ?? fetch);
    }
  } catch (error) {
    log("DEBUG", `get_syllabus: could not read content syllabus topic ${best.topicId}`, error);
  }

  return {
    source,
    ...(text?.trim() ? { text: text.trim() } : {}),
    ...(rest.length > 0 ? { otherCandidates: rest.map(({ content: _c, ...s }) => s) } : {}),
  };
}

/**
 * A syllabus link posted in an announcement ("Syllabus: https://..."), for
 * courses that keep the syllabus on an outside site. Only the link is
 * reported; the outside page is not fetched.
 */
async function findAnnouncedSyllabus(apiClient: D2LApiClient, courseId: number): Promise<ContentSyllabus | null> {
  try {
    const news = await apiClient.get<Array<{ Id: number; Title: string; Body?: { Text?: string; Html?: string } }>>(
      apiClient.le(courseId, "/news/"),
      { ttl: DEFAULT_CACHE_TTLS.announcements }
    );
    for (const item of Array.isArray(news) ? news : []) {
      const body = item.Body?.Text || item.Body?.Html?.replace(/<[^>]+>/g, " ") || "";
      const url = /syllabus[^\n]*?(https?:\/\/[^\s"'<>)\]]+)/i.exec(body)?.[1];
      if (url) return { source: { title: item.Title, announcementId: item.Id, kind: "announcementLink", url } };
    }
  } catch (error) {
    log("DEBUG", `get_syllabus: announcements unavailable for course ${courseId}`, error);
  }
  return null;
}

/** A filename whose extension matches the bytes, so the right extractor runs. */
function guessName(title: string, buffer: Buffer): string {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return `${title}.pdf`;
  if (buffer.subarray(0, 2).toString("latin1") === "PK") {
    const head = buffer.subarray(0, 4000).toString("latin1");
    if (head.includes("word/")) return `${title}.docx`;
    if (head.includes("ppt/")) return `${title}.pptx`;
    if (head.includes("xl/")) return `${title}.xlsx`;
  }
  return `${title}.txt`;
}

/**
 * The text of a Google Doc shared as "anyone with the link", through its
 * plain-text export. A private doc answers with a login page or 403, and
 * this returns undefined.
 */
async function readPublicGoogleDoc(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const id = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/.exec(url)?.[1];
  if (!id) return undefined;
  const response = await fetchImpl(`https://docs.google.com/document/d/${id}/export?format=txt`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/plain")) return undefined;
  return (await response.text()).replace(/^﻿/, "");
}

/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { extractTextItems, getDocumentProxy, renderPageAsImage } from "unpdf";
import type { StructuredTextItem } from "unpdf";
import { log } from "./logger.js";

export interface PdfExtraction {
  /**
   * Page-marked text: in a multi-page document every page (or collapsed run
   * of slide builds) starts with a `--- Page N ---` line.
   */
  text: string;
  totalPages: number;
  /** The 1-based pages whose text is included, after any page range. */
  pagesIncluded: number[];
  /** Pages dropped because the page after them is a later build of the same slide. */
  collapsedPages: number[];
}

export interface PdfExtractOptions {
  /** 1-based pages to include. Omitted means every page. */
  pages?: number[];
  /**
   * Drop a page when the next page repeats all of its lines (an incremental
   * slide build), keeping only the final build. Defaults to true.
   */
  collapseSlideBuilds?: boolean;
}

/**
 * Parse a page range such as "3", "10-20", "1,4-6" or "5-" into sorted,
 * de-duplicated 1-based page numbers clamped to the document. Throws on
 * malformed input or a range that selects nothing.
 */
export function parsePageRange(spec: string, totalPages: number): number[] {
  const pages = new Set<number>();
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!match || (!match[1] && !match[3])) {
      throw new Error(`Invalid page range "${part}". Use forms like "3", "10-20", "1,4-6" or "5-".`);
    }
    const start = match[1] ? Number(match[1]) : 1;
    const end = match[2] ? (match[3] ? Number(match[3]) : totalPages) : start;
    if (start < 1 || end < start) throw new Error(`Invalid page range "${part}".`);
    for (let p = start; p <= Math.min(end, totalPages); p++) pages.add(p);
  }
  if (pages.size === 0) {
    throw new Error(`Page range "${spec}" selects no pages (the document has ${totalPages}).`);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Rebuild reading-order lines from positioned text items. pdf.js hands back
 * text in content-stream order with a line break wherever the baseline moves,
 * so a subscript or superscript lands on a line of its own and `x_i^2`
 * arrives as three lines. Grouping items whose vertical extents overlap puts
 * them back on one line, ordered left to right.
 */
export function layoutPageText(items: StructuredTextItem[]): string {
  interface Line { top: number; bottom: number; items: StructuredTextItem[] }
  const visible = items.filter((it) => it.str.trim() !== "");
  // Top of the page first (PDF y grows upward), then left to right.
  visible.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  for (const item of visible) {
    const size = item.height || item.fontSize || 1;
    const bottom = item.y;
    const top = item.y + size;
    let best: Line | undefined;
    let bestOverlap = 0;
    for (const line of lines) {
      const overlap = Math.min(top, line.top) - Math.max(bottom, line.bottom);
      const smaller = Math.min(top - bottom, line.top - line.bottom);
      const ratio = smaller > 0 ? overlap / smaller : 0;
      if (ratio > 0.3 && ratio > bestOverlap) {
        best = line;
        bestOverlap = ratio;
      }
    }
    if (best) {
      best.items.push(item);
      // Keep the line's extent anchored to its full-size text so a run of
      // subscripts cannot drag it down into the next line.
      if (size >= best.top - best.bottom) {
        best.top = top;
        best.bottom = bottom;
      }
    } else {
      lines.push({ top, bottom, items: [item] });
    }
  }

  lines.sort((a, b) => b.bottom - a.bottom);
  return lines
    .map((line) => {
      const sorted = line.items.sort((a, b) => a.x - b.x);
      let out = "";
      let prevEnd: number | undefined;
      for (const item of sorted) {
        const em = item.fontSize || item.height || 10;
        if (prevEnd !== undefined) {
          const gap = item.x - prevEnd;
          if (gap > em * 2) out += "    ";
          else if (gap > em * 0.15 && !out.endsWith(" ") && !item.str.startsWith(" ")) out += " ";
        }
        out += item.str;
        prevEnd = item.x + item.width;
      }
      return out.replace(/\s+$/, "");
    })
    .filter((line) => line.trim() !== "")
    .join("\n");
}

function normalizedLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * True when `next` looks like a later build of the slide on `prev`: nearly
 * every line of `prev` reappears on `next`, and `next` adds to it. Beamer
 * overlays and Keynote/PowerPoint "builds" export one PDF page per step, so a
 * 28-slide deck becomes 87 pages that repeat each other.
 */
export function isSlideBuild(prev: string, next: string): boolean {
  const a = normalizedLines(prev);
  const b = normalizedLines(next);
  if (a.length === 0 || b.length < a.length) return false;
  const pool = new Map<string, number>();
  for (const line of b) pool.set(line, (pool.get(line) ?? 0) + 1);
  let found = 0;
  for (const line of a) {
    const n = pool.get(line) ?? 0;
    if (n > 0) {
      found++;
      pool.set(line, n - 1);
    }
  }
  return found / a.length >= 0.9;
}

/**
 * Extract page-marked text from a PDF buffer.
 * Returns null on failure (graceful degradation — download still works).
 */
export async function extractPdfText(
  buffer: Buffer,
  options: PdfExtractOptions = {}
): Promise<PdfExtraction | null> {
  try {
    const { totalPages, items } = await extractTextItems(new Uint8Array(buffer));
    const wanted = options.pages ?? Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = wanted
      .filter((p) => p >= 1 && p <= totalPages)
      .map((p) => ({ page: p, text: layoutPageText(items[p - 1] ?? []) }));

    const collapse = options.collapseSlideBuilds ?? true;
    const collapsedPages: number[] = [];
    const blocks: string[] = [];
    let runStart: number | undefined;

    for (let i = 0; i < pages.length; i++) {
      const current = pages[i];
      const next = pages[i + 1];
      const contiguous = next !== undefined && next.page === current.page + 1;
      if (collapse && contiguous && isSlideBuild(current.text, next.text)) {
        runStart ??= current.page;
        collapsedPages.push(current.page);
        continue;
      }
      const label =
        runStart !== undefined
          ? `--- Pages ${runStart}-${current.page} (slide builds; final build shown) ---`
          : `--- Page ${current.page} ---`;
      runStart = undefined;
      // A one-page document has nothing to tell apart, so it goes unmarked.
      if (current.text) blocks.push(totalPages === 1 ? current.text : `${label}\n${current.text}`);
    }

    return {
      text: blocks.join("\n\n"),
      totalPages,
      pagesIncluded: pages.map((p) => p.page),
      collapsedPages,
    };
  } catch (error) {
    log("ERROR", "Failed to extract text from PDF", error);
    return null;
  }
}

/** Count a PDF's pages without extracting anything, or null if it cannot be parsed. */
export async function pdfPageCount(buffer: Buffer): Promise<number | null> {
  try {
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    return doc.numPages;
  } catch {
    return null;
  }
}

/**
 * Render PDF pages to PNG, for slides whose math and figures do not survive
 * text extraction. Needs the optional @napi-rs/canvas dependency; returns
 * null when it is not installed so the caller can fall back to text.
 */
export async function renderPdfPages(
  buffer: Buffer,
  pages: number[],
  targetWidth = 1400
): Promise<Array<{ page: number; png: Buffer }> | null> {
  let canvasImport: () => Promise<typeof import("@napi-rs/canvas")>;
  try {
    const canvas = await import("@napi-rs/canvas");
    canvasImport = async () => canvas;
  } catch {
    log("WARN", "renderPdfPages: @napi-rs/canvas is not installed; page images unavailable");
    return null;
  }
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const out: Array<{ page: number; png: Buffer }> = [];
  for (const page of pages) {
    if (page < 1 || page > doc.numPages) continue;
    const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
    const scale = Math.min(3, targetWidth / viewport.width);
    const png = await renderPageAsImage(doc, page, { canvasImport, scale });
    out.push({ page, png: Buffer.from(png) });
  }
  return out;
}

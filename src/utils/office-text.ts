/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen. Portions adapted from zip-extract.ts,
 * Copyright (c) 2026 Rohan Muppa.
 * Licensed under MIT — see LICENSE file for details.
 */

import { extractZipEntry, listZipEntries } from "./zip-extract.js";
import {
  childElements,
  descendants,
  firstChild,
  parseXml,
  path,
  textContent,
  type XmlElement,
} from "./xml-lite.js";

/**
 * Structured text for Office documents and notebooks. Each format keeps the
 * structure a reader needs: DOCX headings, lists and tables as Markdown;
 * every XLSX sheet as a table of cell values (numbers and dates included,
 * not only the shared strings); PPTX slides in presentation order with their
 * titles and speaker notes.
 */

const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 40;

function readXml(buffer: Buffer, name: string): XmlElement | null {
  const data = extractZipEntry(buffer, name);
  return data ? parseXml(data.toString("utf-8")) : null;
}

/** Map relationship ids to resolved part paths for one .rels file. */
function readRels(buffer: Buffer, relsPath: string, baseDir: string): Map<string, { target: string; type: string }> {
  const rels = new Map<string, { target: string; type: string }>();
  const root = readXml(buffer, relsPath);
  if (!root) return rels;
  for (const rel of descendants(root, "Relationship")) {
    const target = rel.attrs.Target ?? "";
    rels.set(rel.attrs.Id ?? "", { target: resolvePartPath(baseDir, target), type: rel.attrs.Type ?? "" });
  }
  return rels;
}

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir ? baseDir.split("/") : [];
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " <br> ").trim();
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => [...r, ...Array(width - r.length).fill("")].map(escapeCell));
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(padded[0]), line(padded[0].map(() => "---")), ...padded.slice(1).map(line)].join("\n");
}

// ---------------------------------------------------------------- DOCX

/** Text of a run container, honoring tabs and breaks and skipping deleted text. */
function docxRunText(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") continue;
    switch (child.name) {
      case "w:t":
      case "m:t":
        out += textContent(child);
        break;
      case "w:tab":
        out += "\t";
        break;
      case "w:br":
      case "w:cr":
        out += "\n";
        break;
      case "w:delText":
      case "w:instrText":
      case "w:pPr":
      case "w:rPr":
        break;
      default:
        out += docxRunText(child);
    }
  }
  return out;
}

function docxParagraph(p: XmlElement): string {
  const text = docxRunText(p).replace(/[ \t]+$/g, "");
  if (!text.trim()) return "";
  const pPr = firstChild(p, "w:pPr");
  const style = path(pPr, "w:pStyle")?.attrs["w:val"] ?? "";
  const heading = /^heading\s*(\d)$/i.exec(style);
  if (heading) return `${"#".repeat(Math.min(Number(heading[1]), 6))} ${text.trim()}`;
  if (/^title$/i.test(style)) return `# ${text.trim()}`;
  const numPr = path(pPr, "w:numPr");
  if (numPr || /list/i.test(style)) {
    const level = Number(path(numPr, "w:ilvl")?.attrs["w:val"] ?? 0);
    return `${"  ".repeat(level)}- ${text.trim()}`;
  }
  return text;
}

function docxTable(tbl: XmlElement): string {
  const rows = childElements(tbl, "w:tr").map((tr) =>
    childElements(tr, "w:tc").map((tc) =>
      docxBlocks(tc).join("\n")
    )
  );
  return rows.length > 0 ? markdownTable(rows) : "";
}

function docxBlocks(container: XmlElement): string[] {
  const blocks: string[] = [];
  for (const child of childElements(container)) {
    if (child.name === "w:p") blocks.push(docxParagraph(child));
    else if (child.name === "w:tbl") blocks.push(docxTable(child));
    else if (child.name === "w:sdt") blocks.push(...docxBlocks(firstChild(child, "w:sdtContent") ?? child));
    else if (child.name === "w:body" || child.name === "w:document") blocks.push(...docxBlocks(child));
  }
  return blocks.filter(Boolean);
}

export function docxText(buffer: Buffer): string | null {
  const root = readXml(buffer, "word/document.xml");
  if (!root) return null;
  let blocks = docxBlocks(root);
  if (blocks.length === 0) {
    // No paragraph structure at all: fall back to the bare runs.
    blocks = descendants(root, "w:t").map(textContent).filter((t) => t.trim());
    return blocks.length > 0 ? blocks.join(" ").replace(/\s+/g, " ").trim() : null;
  }
  // Consecutive list items stay a tight list; everything else is a paragraph.
  const isItem = (b: string) => /^\s*- /.test(b);
  return blocks.reduce((out, block, i) => {
    if (i === 0) return block;
    return out + (isItem(block) && isItem(blocks[i - 1]) ? "\n" : "\n\n") + block;
  }, "");
}

// ---------------------------------------------------------------- XLSX

/** Built-in number formats that display a date or time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyleIndexes(buffer: Buffer): Set<number> {
  const styles = readXml(buffer, "xl/styles.xml");
  const dates = new Set<number>();
  if (!styles) return dates;
  const custom = new Map<number, string>();
  for (const fmt of descendants(styles, "numFmt")) {
    custom.set(Number(fmt.attrs.numFmtId), fmt.attrs.formatCode ?? "");
  }
  const cellXfs = descendants(styles, "cellXfs")[0];
  childElements(cellXfs ?? { name: "", attrs: {}, children: [] }, "xf").forEach((xf, index) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (BUILTIN_DATE_FORMATS.has(id) || /[dy]|m{3,}|h+:m/i.test(code)) dates.add(index);
  });
  return dates;
}

/** Convert an Excel serial date (1900 system) to ISO 8601. */
function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const iso = new Date(ms).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function xlsxText(buffer: Buffer): string | null {
  const names = listZipEntries(buffer) ?? [];
  const shared = (() => {
    const sst = readXml(buffer, "xl/sharedStrings.xml");
    return sst ? descendants(sst, "si").map((si) => descendants(si, "t").map(textContent).join("")) : [];
  })();
  const dateStyles = dateStyleIndexes(buffer);

  // Sheets in workbook order, falling back to the parts present.
  const workbook = readXml(buffer, "xl/workbook.xml");
  const rels = readRels(buffer, "xl/_rels/workbook.xml.rels", "xl");
  let sheets = workbook
    ? descendants(workbook, "sheet")
        .map((s) => ({ name: s.attrs.name ?? "Sheet", part: rels.get(s.attrs["r:id"] ?? "")?.target ?? "" }))
        .filter((s) => names.includes(s.part))
    : [];
  if (sheets.length === 0) {
    sheets = names
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))
      .map((part, i) => ({ name: `Sheet${i + 1}`, part }));
  }

  const sections: string[] = [];
  for (const sheet of sheets) {
    const root = readXml(buffer, sheet.part);
    if (!root) continue;
    const grid = new Map<number, Map<number, string>>();
    let maxCol = -1;
    for (const row of descendants(root, "row")) {
      const rowNumber = Number(row.attrs.r ?? grid.size + 1);
      const cells = new Map<number, string>();
      childElements(row, "c").forEach((c, i) => {
        const col = c.attrs.r ? columnIndex(c.attrs.r) : i;
        const raw = path(c, "v") ? textContent(path(c, "v")!) : "";
        let value: string;
        switch (c.attrs.t) {
          case "s":
            value = shared[Number(raw)] ?? "";
            break;
          case "str":
            value = raw || (path(c, "f") ? `=${textContent(path(c, "f")!)}` : "");
            break;
          case "inlineStr":
            value = descendants(c, "t").map(textContent).join("");
            break;
          case "b":
            value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
            break;
          default:
            value = raw;
            if (!raw && path(c, "f")) value = `=${textContent(path(c, "f")!)}`;
            if (raw && dateStyles.has(Number(c.attrs.s ?? -1)) && Number.isFinite(Number(raw))) {
              value = excelSerialToIso(Number(raw));
            }
        }
        if (value !== "") {
          cells.set(col, value);
          maxCol = Math.max(maxCol, col);
        }
      });
      if (cells.size > 0) grid.set(rowNumber, cells);
    }
    if (grid.size === 0) continue;

    const width = Math.min(maxCol + 1, MAX_SHEET_COLS);
    const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
    const shown = rowNumbers.slice(0, MAX_SHEET_ROWS);
    const header = ["Row", ...Array.from({ length: width }, (_, i) => columnName(i))];
    const body = shown.map((r) => [String(r), ...Array.from({ length: width }, (_, i) => grid.get(r)!.get(i) ?? "")]);
    let section = `## Sheet: ${sheet.name}\n\n${markdownTable([header, ...body])}`;
    const notes: string[] = [];
    if (rowNumbers.length > shown.length) notes.push(`${rowNumbers.length - shown.length} more rows not shown`);
    if (maxCol + 1 > width) notes.push(`${maxCol + 1 - width} more columns not shown`);
    if (notes.length > 0) section += `\n\n(${notes.join("; ")})`;
    sections.push(section);
  }

  if (sections.length === 0) {
    // A workbook whose sheets could not be read still has its strings.
    return shared.filter(Boolean).join("\n") || null;
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------- PPTX

function pptxParagraphs(container: XmlElement): string[] {
  return descendants(container, "a:p")
    .map((p) =>
      p.children
        .map((c) => {
          if (typeof c === "string") return "";
          if (c.name === "a:br") return "\n";
          return descendants(c, "a:t").map(textContent).join("") + (c.name === "a:t" ? textContent(c) : "");
        })
        .join("")
        .trim()
    )
    .filter(Boolean);
}

function placeholderType(shape: XmlElement): string | undefined {
  const nvPr = path(shape, "p:nvSpPr", "p:nvPr") ?? path(shape, "p:nvGraphicFramePr", "p:nvPr");
  return path(nvPr, "p:ph")?.attrs.type;
}

function pptxSlideText(slide: XmlElement): { title: string; lines: string[] } {
  let title = "";
  const lines: string[] = [];
  for (const shape of [...descendants(slide, "p:sp"), ...descendants(slide, "p:graphicFrame")]) {
    const type = placeholderType(shape);
    if (type === "sldNum" || type === "dt" || type === "ftr") continue;
    const tables = descendants(shape, "a:tbl");
    if (tables.length > 0) {
      for (const tbl of tables) {
        const rows = childElements(tbl, "a:tr").map((tr) =>
          childElements(tr, "a:tc").map((tc) => pptxParagraphs(tc).join(" "))
        );
        if (rows.length > 0) lines.push(markdownTable(rows));
      }
      continue;
    }
    const paragraphs = pptxParagraphs(shape);
    if ((type === "title" || type === "ctrTitle") && !title) title = paragraphs.join(" ");
    else lines.push(...paragraphs.map((p) => `- ${p}`));
  }
  if (!title && lines.length === 0) {
    // Text outside any shape: keep the bare runs rather than drop the slide.
    lines.push(...descendants(slide, "a:t").map(textContent).filter((t) => t.trim()));
  }
  return { title, lines };
}

export function pptxText(buffer: Buffer): string | null {
  const names = listZipEntries(buffer) ?? [];
  const presentation = readXml(buffer, "ppt/presentation.xml");
  const rels = readRels(buffer, "ppt/_rels/presentation.xml.rels", "ppt");
  let slideParts = presentation
    ? descendants(presentation, "p:sldId")
        .map((s) => rels.get(s.attrs["r:id"] ?? "")?.target ?? "")
        .filter((p) => names.includes(p))
    : [];
  if (slideParts.length === 0) {
    slideParts = names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  }

  const slides: string[] = [];
  slideParts.forEach((part, index) => {
    const root = readXml(buffer, part);
    if (!root) return;
    const sld = descendants(root, "p:sld")[0] ?? root;
    const { title, lines } = pptxSlideText(sld);

    const dir = part.slice(0, part.lastIndexOf("/"));
    const file = part.slice(part.lastIndexOf("/") + 1);
    const slideRels = readRels(buffer, `${dir}/_rels/${file}.rels`, dir);
    const notesPart = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    let notes = "";
    if (notesPart) {
      const notesRoot = readXml(buffer, notesPart);
      if (notesRoot) {
        notes = descendants(notesRoot, "p:sp")
          .filter((sp) => placeholderType(sp) === "body")
          .flatMap((sp) => pptxParagraphs(sp))
          .join("\n");
      }
    }

    const hidden = sld.attrs.show === "0" ? " (hidden)" : "";
    const heading = `## Slide ${index + 1}${title ? `: ${title}` : ""}${hidden}`;
    const parts = [heading, ...lines];
    if (notes) parts.push(`Speaker notes: ${notes}`);
    if (title || lines.length > 0 || notes) slides.push(parts.join("\n"));
  });

  return slides.length > 0 ? slides.join("\n\n") : null;
}

// ---------------------------------------------------------------- dispatch

/**
 * Readable text from a DOCX, XLSX, or PPTX buffer, or null when the archive
 * is not an Office document or carries nothing readable.
 */
export function officeDocumentText(buffer: Buffer): string | null {
  const names = listZipEntries(buffer);
  if (!names) return null;
  let text: string | null;
  if (names.includes("word/document.xml")) text = docxText(buffer);
  else if (names.some((n) => n.startsWith("xl/"))) text = xlsxText(buffer);
  else if (names.some((n) => n.startsWith("ppt/slides/slide"))) text = pptxText(buffer);
  else return null;
  return text && text.trim().length > 0 ? text : null;
}

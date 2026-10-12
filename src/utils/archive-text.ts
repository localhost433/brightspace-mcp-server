/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

import { extractZipEntry, listZipEntries } from "./zip-extract.js";
import { notebookText } from "./notebook-text.js";
import { officeDocumentText } from "./office-text.js";
import { extractPdfText } from "./pdf-extractor.js";

/** Extensions read as source or plain text when found inside an archive. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "html", "css",
  "py", "ipynb", "r", "rmd", "m", "jl", "java", "kt", "scala", "c", "h", "cc", "cpp", "hpp",
  "cs", "go", "rs", "js", "jsx", "ts", "tsx", "rb", "php", "sh", "sql", "tex", "bib", "s", "asm",
  "makefile", "dockerfile", "gitignore",
]);

const MAX_ARCHIVE_TEXT_CHARS = 200_000;
const MAX_ENTRY_TEXT_CHARS = 40_000;

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? "";
  if (!base.includes(".")) return base.toLowerCase();
  return base.split(".").pop()!.toLowerCase();
}

/** Text from a document type this server already reads, or null. */
export async function documentTextForName(name: string, data: Buffer): Promise<string | null> {
  const ext = extensionOf(name);
  if (ext === "ipynb") return notebookText(data.toString("utf-8"));
  if (ext === "pdf") return (await extractPdfText(data))?.text || null;
  if (ext === "docx" || ext === "xlsx" || ext === "pptx") return officeDocumentText(data);
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = data.toString("utf-8");
    return text.includes("\u0000") ? null : text;
  }
  return null;
}

/**
 * A zip archive (starter code, a dataset bundle) as a file listing followed
 * by the contents of its readable files, until a character budget runs out.
 * Returns null when the buffer is not a readable zip.
 */
export async function archiveText(buffer: Buffer): Promise<string | null> {
  const names = listZipEntries(buffer);
  if (!names) return null;
  const files = names.filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/") && !n.split("/").pop()!.startsWith("._"));

  const sections = [`Archive contents (${files.length} file${files.length === 1 ? "" : "s"}):\n${files.map((f) => `- ${f}`).join("\n")}`];
  let budget = MAX_ARCHIVE_TEXT_CHARS;
  const skipped: string[] = [];
  for (const name of files) {
    const data = extractZipEntry(buffer, name);
    const text = data ? await documentTextForName(name, data) : null;
    if (!text?.trim()) continue;
    if (budget <= 0) {
      skipped.push(name);
      continue;
    }
    const clipped = text.length > MAX_ENTRY_TEXT_CHARS
      ? `${text.slice(0, MAX_ENTRY_TEXT_CHARS)}\n[... ${text.length - MAX_ENTRY_TEXT_CHARS} more characters]`
      : text;
    sections.push(`=== ${name} ===\n${clipped.slice(0, budget)}`);
    budget -= clipped.length;
  }
  if (skipped.length > 0) {
    sections.push(`(Not shown, over the size budget: ${skipped.join(", ")})`);
  }
  return sections.join("\n\n");
}

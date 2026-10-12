/**
 * Brightspace MCP Server (NYU fork)
 * Copyright (c) 2026 Robin Chen.
 * Licensed under MIT — see LICENSE file for details.
 */

/** Longest single cell output kept; plots and long logs are summarized past this. */
const MAX_OUTPUT_CHARS = 2000;

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: Array<{
    output_type?: string;
    name?: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
    ename?: string;
    evalue?: string;
  }>;
}

function joinSource(source: string | string[] | undefined): string {
  return (Array.isArray(source) ? source.join("") : source ?? "").replace(/\s+$/, "");
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[... ${text.length - MAX_OUTPUT_CHARS} more characters of output]`
    : text;
}

/**
 * A Jupyter notebook as Markdown: markdown cells as written, code cells
 * fenced in the kernel's language, and outputs summarized beneath them.
 * Returns null when the JSON is not a notebook.
 */
export function notebookText(json: string): string | null {
  let nb: { cells?: NotebookCell[]; metadata?: Record<string, any> };
  try {
    nb = JSON.parse(json);
  } catch {
    return null;
  }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const language: string =
    nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "python";

  const blocks: string[] = [];
  nb.cells.forEach((cell, index) => {
    const source = joinSource(cell.source);
    if (cell.cell_type === "markdown" || cell.cell_type === "raw") {
      if (source) blocks.push(source);
      return;
    }
    if (cell.cell_type !== "code") return;
    const parts = [`In [${index + 1}]:`, "```" + language, source, "```"];
    const outputs: string[] = [];
    for (const out of cell.outputs ?? []) {
      if (out.output_type === "stream") {
        outputs.push(clip(joinSource(out.text)));
      } else if (out.output_type === "error") {
        outputs.push(`${out.ename ?? "Error"}: ${out.evalue ?? ""}`);
      } else if (out.data) {
        const plain = out.data["text/plain"];
        const kinds = Object.keys(out.data).filter((k) => k.startsWith("image/"));
        if (plain !== undefined) outputs.push(clip(joinSource(plain)));
        else if (kinds.length > 0) outputs.push(`[${kinds.join(", ")} output]`);
      }
    }
    if (outputs.some(Boolean)) parts.push("Output:", "```", outputs.filter(Boolean).join("\n"), "```");
    blocks.push(parts.join("\n"));
  });
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

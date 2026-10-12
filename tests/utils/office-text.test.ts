import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { officeDocumentText } from "../../src/utils/office-text.js";
import { notebookText } from "../../src/utils/notebook-text.js";
import { archiveText } from "../../src/utils/archive-text.js";

/**
 * The fixtures were written by python-docx, openpyxl and python-pptx, so they
 * carry the same part layout, relationships and styles real course files do.
 */
const fixture = (name: string) => readFileSync(new URL(`../fixtures/office/${name}`, import.meta.url));

describe("officeDocumentText on real Office files", () => {
  it("keeps DOCX headings, tight lists and tables", () => {
    expect(officeDocumentText(fixture("lab4.docx"))).toBe(
      "# Lab 4: Linear Models\n\n" +
        "Submit by Friday & include code.\n\n" +
        "- Fit OLS\n- Report R² | adj R²\n\n" +
        "| Part | Points |\n| --- | --- |\n| A | 40 |"
    );
  });

  it("reads every XLSX sheet with numbers and dates, not just shared strings", () => {
    const text = officeDocumentText(fixture("grades.xlsx")) ?? "";
    expect(text).toContain("## Sheet: Grades");
    expect(text).toContain("| 2 | HW1 | 95.5 | 2026-09-11 |");
    expect(text).toContain("| 3 | HW2 | 88 | 2026-10-05 |");
    expect(text).toContain("## Sheet: Notes");
  });

  it("shows a formula whose value was never calculated", () => {
    expect(officeDocumentText(fixture("grades.xlsx"))).toContain("=SUM(B2:B3)");
  });

  it("gives PPTX slides their titles, bullets, tables and speaker notes", () => {
    expect(officeDocumentText(fixture("slides.pptx"))).toBe(
      "## Slide 1: Gradient Descent\n- Step size η\n- Converges if convex\nSpeaker notes: Mention momentum here\n\n" +
        "## Slide 2: Results\n| Model | Acc |\n| --- | --- |\n| LR | 0.91 |"
    );
  });
});

describe("notebookText", () => {
  const nb = {
    metadata: { kernelspec: { language: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# PA2\n", "Fit a model."] },
      {
        cell_type: "code",
        source: "print(1 + 1)",
        outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }],
      },
      {
        cell_type: "code",
        source: "plot()",
        outputs: [{ output_type: "display_data", data: { "image/png": "iVBOR" } }],
      },
      { cell_type: "code", source: "1/0", outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero" }] },
    ],
  };

  it("renders markdown, fenced code and summarized outputs", () => {
    expect(notebookText(JSON.stringify(nb))).toBe(
      "# PA2\nFit a model.\n\n" +
        "In [2]:\n```python\nprint(1 + 1)\n```\nOutput:\n```\n2\n```\n\n" +
        "In [3]:\n```python\nplot()\n```\nOutput:\n```\n[image/png output]\n```\n\n" +
        "In [4]:\n```python\n1/0\n```\nOutput:\n```\nZeroDivisionError: division by zero\n```"
    );
  });

  it("returns null for JSON that is not a notebook", () => {
    expect(notebookText('{"a": 1}')).toBeNull();
    expect(notebookText("not json")).toBeNull();
  });
});

describe("archiveText", () => {
  function storedZip(entries: Array<[string, string]>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [entryName, body] of entries) {
      const name = Buffer.from(entryName);
      const data = deflateRawSync(Buffer.from(body));
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(name.length, 26);
      const block = Buffer.concat([local, name, data]);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(body.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(Buffer.concat([central, name]));
      locals.push(block);
      offset += block.length;
    }
    const dir = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, eocd]);
  }

  it("lists the files and shows the readable ones", async () => {
    const text = await archiveText(
      storedZip([
        ["starter/main.py", "def solve():\n    pass\n"],
        ["starter/data.bin", "\u0000\u0001"],
        ["__MACOSX/._main.py", "junk"],
      ])
    );
    expect(text).toContain("Archive contents (2 files):\n- starter/main.py\n- starter/data.bin");
    expect(text).toContain("=== starter/main.py ===\ndef solve():");
    expect(text).not.toContain("=== starter/data.bin");
    expect(text).not.toContain("__MACOSX");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractPdfText,
  isSlideBuild,
  layoutPageText,
  parsePageRange,
} from "../../src/utils/pdf-extractor.js";
import type { StructuredTextItem } from "unpdf";

/**
 * PDF bytes come from a course attachment, so they are remote input and can be
 * malformed, truncated, or hostile. The contract is graceful degradation: the
 * extractor returns null and the download still succeeds without text. Nothing
 * it is handed may throw out of it and take the tool call down.
 */

describe("extractPdfText", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The failure path logs at ERROR; keep the suite's output readable.
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("returns null for an empty buffer", async () => {
    await expect(extractPdfText(Buffer.alloc(0))).resolves.toBeNull();
  });

  it("returns null for bytes that are not a PDF at all", async () => {
    await expect(extractPdfText(Buffer.from("this is plainly not a pdf"))).resolves.toBeNull();
  });

  it("returns null for a PDF header with a broken body", async () => {
    await expect(
      extractPdfText(Buffer.from("%PDF-1.4\nnot actually a pdf body"))
    ).resolves.toBeNull();
  });

  it("returns null for a truncated PDF", async () => {
    await expect(
      extractPdfText(
        Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n")
      )
    ).resolves.toBeNull();
  });

  it("yields no text for a PDF claiming a page count it does not have", async () => {
    // pdf.js repairs this one rather than throwing, so the result is an empty
    // extraction rather than null. Either way the caller gets nothing usable
    // and nothing escapes: `extracted?.text?.trim() || null` at both call
    // sites turns both shapes into the same "no text layer" note.
    const result = await extractPdfText(
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "2 0 obj\n<< /Type /Pages /Count 999999 /Kids [] >>\nendobj\n" +
          "trailer\n<< /Root 1 0 R >>\n%%EOF\n"
      )
    );
    expect(result?.text ?? "").toBe("");
  });

  it("extracts text from a well-formed PDF", async () => {
    const result = await extractPdfText(minimalPdf("Homework 3 is due Friday"));
    expect(result).not.toBeNull();
    expect(result?.totalPages).toBe(1);
    expect(result?.text).toContain("Homework 3 is due Friday");
  });
});

describe("extractPdfText on multi-page documents", () => {
  it("marks each page", async () => {
    const result = await extractPdfText(pdfWithPages([["Week 1 notes"], ["Week 2 notes"]]));
    expect(result?.text).toBe("--- Page 1 ---\nWeek 1 notes\n\n--- Page 2 ---\nWeek 2 notes");
    expect(result?.collapsedPages).toEqual([]);
  });

  it("collapses incremental slide builds to the final build", async () => {
    const result = await extractPdfText(
      pdfWithPages([["Regression", "Point one"], ["Regression", "Point one", "Point two"], ["Next slide"]])
    );
    expect(result?.text).toBe(
      "--- Pages 1-2 (slide builds; final build shown) ---\nRegression\nPoint one\nPoint two\n\n" +
        "--- Page 3 ---\nNext slide"
    );
    expect(result?.collapsedPages).toEqual([1]);
  });

  it("keeps every build when collapsing is turned off", async () => {
    const result = await extractPdfText(
      pdfWithPages([["Regression", "Point one"], ["Regression", "Point one", "Point two"]]),
      { collapseSlideBuilds: false }
    );
    expect(result?.text).toContain("--- Page 1 ---");
    expect(result?.text).toContain("--- Page 2 ---");
  });

  it("extracts only the requested pages", async () => {
    const result = await extractPdfText(pdfWithPages([["One"], ["Two"], ["Three"]]), { pages: [2, 3] });
    expect(result?.pagesIncluded).toEqual([2, 3]);
    expect(result?.text).toBe("--- Page 2 ---\nTwo\n\n--- Page 3 ---\nThree");
  });

  it("does not collapse across a gap in the requested pages", async () => {
    const result = await extractPdfText(
      pdfWithPages([["A"], ["X"], ["A", "B"]]),
      { pages: [1, 3] }
    );
    expect(result?.collapsedPages).toEqual([]);
  });
});

describe("parsePageRange", () => {
  it("parses single pages, ranges, lists and open ends", () => {
    expect(parsePageRange("3", 10)).toEqual([3]);
    expect(parsePageRange("2-4", 10)).toEqual([2, 3, 4]);
    expect(parsePageRange("1, 4-5, 4", 10)).toEqual([1, 4, 5]);
    expect(parsePageRange("8-", 10)).toEqual([8, 9, 10]);
    expect(parsePageRange("-2", 10)).toEqual([1, 2]);
  });

  it("clamps to the document", () => {
    expect(parsePageRange("9-20", 10)).toEqual([9, 10]);
  });

  it("rejects malformed or empty ranges", () => {
    expect(() => parsePageRange("abc", 10)).toThrow(/Invalid page range/);
    expect(() => parsePageRange("5-2", 10)).toThrow(/Invalid page range/);
    expect(() => parsePageRange("11-12", 10)).toThrow(/selects no pages/);
  });
});

describe("layoutPageText", () => {
  const item = (str: string, x: number, y: number, size: number, width: number): StructuredTextItem =>
    ({ str, x, y, width, height: size, fontSize: size, fontFamily: "", dir: "ltr" }) as StructuredTextItem;

  it("puts a subscript back on its baseline's line", () => {
    const text = layoutPageText([
      item("given", 72, 700, 12, 30),
      item("x", 104, 700, 12, 6),
      item("i", 110, 697, 8, 3),
      item("and more", 115, 700, 12, 45),
    ]);
    expect(text).toBe("given xi and more");
  });

  it("orders lines top to bottom and items left to right", () => {
    const text = layoutPageText([
      item("second", 72, 680, 12, 36),
      item("right", 120, 700, 12, 30),
      item("left", 72, 700, 12, 24),
    ]);
    expect(text).toBe("left right\nsecond");
  });
});

describe("isSlideBuild", () => {
  it("recognizes a later build that adds lines", () => {
    expect(isSlideBuild("Title\nA", "Title\nA\nB")).toBe(true);
  });

  it("rejects pages that do not repeat the previous one", () => {
    expect(isSlideBuild("Title\nA", "Other\nB\nC")).toBe(false);
    expect(isSlideBuild("Title\nA\nB", "Title\nA")).toBe(false);
    expect(isSlideBuild("", "Title")).toBe(false);
  });
});

/** The smallest one-page PDF that really renders the given text. */
function minimalPdf(text: string): Buffer {
  return pdfWithPages([[text]]);
}

/** A PDF with one page per entry, each line drawn 20pt below the last. */
function pdfWithPages(pages: string[][]): Buffer {
  const fontRef = 3 + pages.length * 2;
  const pageRefs = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`,
  ];
  pages.forEach((lines, i) => {
    const stream = lines.map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 20} Td (${line}) Tj ET`).join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontRef} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

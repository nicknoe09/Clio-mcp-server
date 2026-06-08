// ============================================================
// docx generation helpers (extracted from documents.ts)
// Small builders over the `docx` library used to assemble downloadable Word docs
// (firm scorecard, V&D statement, etc.).
// ============================================================
import {
  Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType, PageBreak,
} from "docx";

// ---- docx table helpers ----
export const border = { style: BorderStyle.SINGLE, size: 1, color: "999999" };
export const borders = { top: border, bottom: border, left: border, right: border };
export const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };
export const TW = 9360;

export function $(text: string, opts: any = {}) {
  return new TextRun({ text, font: "Arial", size: 20, ...opts });
}

export function makePara(text?: string, opts: any = {}) {
  const children = text ? [$(text, { bold: opts.bold, size: opts.size || 20, color: opts.color })] : opts.runs || [];
  return new Paragraph({ children, spacing: { after: opts.spacingAfter ?? 120, before: opts.spacingBefore }, alignment: opts.alignment });
}

export function makeDocxTable(headers: string[], rows: string[][], colWidths: number[]) {
  const headerRow = new TableRow({
    children: headers.map((h, i) => new TableCell({
      borders, width: { size: colWidths[i], type: WidthType.DXA }, margins: cellMargins,
      shading: { fill: "2E4057", type: ShadingType.CLEAR },
      children: [new Paragraph({ alignment: i > 0 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [$(h, { bold: true, color: "FFFFFF", size: 18 })] })],
    })),
  });

  const dataRows = rows.map(row => {
    const isTotalRow = ["Total", "YTD", "Tier", "Subtotal"].some(kw => String(row[0]).includes(kw));
    return new TableRow({
      children: row.map((cell, i) => new TableCell({
        borders, width: { size: colWidths[i], type: WidthType.DXA }, margins: cellMargins,
        shading: isTotalRow ? { fill: "E8EDF2", type: ShadingType.CLEAR } : undefined,
        children: [new Paragraph({ alignment: i > 0 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [$(String(cell ?? ""), { bold: isTotalRow, size: 18 })] })],
      })),
    });
  });

  return new Table({ width: { size: TW, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows] });
}

export function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }
export function spacer() { return new Paragraph({ spacing: { after: 80 } }); }
export function h2(text: string) { return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [$(text, { size: 24, bold: true, color: "2E4057" })] }); }

// Common page properties
export const pageProps = {
  page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
};

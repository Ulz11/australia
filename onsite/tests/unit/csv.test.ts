/** The Pay export (app/boss/pay/export): cells people typed can't run as formulas, and the download name can't break its header. */
import { describe, it, expect } from "vitest";
import { csvCell, safeFilename } from "@/lib/csv";

describe("CSV export cells", () => {
  it("quotes every cell and doubles the quotes inside it", () => {
    expect(csvCell('Dave "Dozer" Carter')).toBe('"Dave ""Dozer"" Carter"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(8.5)).toBe('"8.5"');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    for (const s of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\r=1"])
      expect(csvCell(s), JSON.stringify(s)).toBe(`"'${s.replace(/"/g, '""')}"`);
  });

  it("leaves plain numbers alone, negative ones included", () => {
    expect(csvCell("-8.0")).toBe('"-8.0"');
    expect(csvCell("36.00")).toBe('"36.00"');
    expect(csvCell(-3)).toBe('"-3"');
  });
});

describe("download names", () => {
  it("keeps a header-safe ASCII name and falls back when nothing is left", () => {
    expect(safeFilename("Marrickville Formwork")).toBe("Marrickville Formwork");
    expect(safeFilename("O'Brien \"Carpentry\" / Sons")).toBe("O Brien Carpentry Sons");
    expect(safeFilename("Café Fitouts")).toBe("Cafe Fitouts");
    expect(safeFilename("Шарма Civil")).toBe("Civil");
    expect(safeFilename("line\nbreak")).toBe("line break");
    expect(safeFilename("   ", "pay")).toBe("pay");
    expect(safeFilename("x".repeat(100))).toHaveLength(60);
  });
});

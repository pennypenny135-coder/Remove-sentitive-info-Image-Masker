/**
 * Text / table / JSON document loading, processing and exporting.
 * All parsing is done in the browser (papaparse for CSV, SheetJS for Excel).
 */
import Papa from "papaparse";
import {
  applyMarks,
  parseMarks,
  suggestTreat,
  type CatId,
  type Engine,
  type Span,
  type Treat,
} from "./pii";

export interface SheetData {
  name: string;
  matrix: string[][];
}

export type Doc =
  | { kind: "text"; name: string; text: string }
  | {
      kind: "table";
      name: string;
      ext: "csv" | "xlsx" | "xls";
      sheets: SheetData[];
      delimiter: string;
      encoding: string;
    }
  | { kind: "json"; name: string; value: unknown };

export interface TableCellPreview {
  o: Span[];
  r: Span[];
}

export interface TableResult {
  rows: string[][];
  preview: Map<string, TableCellPreview>;
}

export interface JsonResult {
  origText: string;
  origSpans: Span[];
  outText: string;
  outSpans: Span[];
}

export const PREVIEW_ROWS = 100;
export const MAX_FILE_BYTES = 150 * 1024 * 1024;

/* ------------------------------ decoding ------------------------------ */

export function decodeText(buf: ArrayBuffer): { text: string; encoding: string } {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(u8), encoding: "UTF-16LE" };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(u8), encoding: "UTF-16BE" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(u8);
    return { text: text.replace(/^\uFEFF/, ""), encoding: "UTF-8" };
  } catch {
    for (const enc of ["big5", "gb18030"]) {
      try {
        return { text: new TextDecoder(enc).decode(u8), encoding: enc.toUpperCase() };
      } catch {
        /* try next */
      }
    }
    return { text: new TextDecoder("utf-8").decode(u8), encoding: "UTF-8 (lossy)" };
  }
}

function normalizeMatrix(data: unknown[][]): string[][] {
  let width = 0;
  for (const r of data) width = Math.max(width, r.length);
  return data.map((r) => {
    const row = new Array<string>(width);
    for (let i = 0; i < width; i++) {
      const v = r[i];
      row[i] = v === undefined || v === null ? "" : String(v);
    }
    return row;
  });
}

export function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export async function loadDocFromFile(file: File): Promise<{ doc: Doc; note?: string }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`檔案過大（${(file.size / 1048576).toFixed(0)} MB），請先拆分後再處理。`);
  const ext = extOf(file.name);
  const buf = await file.arrayBuffer();

  if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
    const sheets: SheetData[] = wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
      return { name, matrix: normalizeMatrix(aoa) };
    });
    if (sheets.length === 0) throw new Error("Excel 檔案內沒有工作表。");
    return {
      doc: { kind: "table", name: file.name, ext: ext === "xls" ? "xls" : "xlsx", sheets, delimiter: ",", encoding: "binary" },
      note: sheets.length > 1 ? `共 ${sheets.length} 個工作表，可於欄位面板切換。` : undefined,
    };
  }

  const { text, encoding } = decodeText(buf);

  if (ext === "csv" || ext === "tsv") {
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", delimiter: ext === "tsv" ? "\t" : undefined });
    const matrix = normalizeMatrix(parsed.data as unknown[][]);
    return {
      doc: {
        kind: "table",
        name: file.name,
        ext: "csv",
        sheets: [{ name: "CSV", matrix }],
        delimiter: parsed.meta.delimiter || ",",
        encoding,
      },
      note: encoding !== "UTF-8" ? `偵測到編碼：${encoding}，匯出時會統一輸出為 UTF-8。` : undefined,
    };
  }

  if (ext === "json") {
    try {
      return { doc: { kind: "json", name: file.name, value: JSON.parse(text) } };
    } catch (e) {
      return {
        doc: { kind: "text", name: file.name, text },
        note: `JSON 解析失敗（${(e as Error).message}），已改以純文字模式載入。`,
      };
    }
  }

  return { doc: { kind: "text", name: file.name, text }, note: encoding !== "UTF-8" ? `偵測到編碼：${encoding}` : undefined };
}

/* ------------------------------ fields ------------------------------ */

export function tableFields(matrix: string[][], hasHeader: boolean): string[] {
  const width = matrix[0]?.length ?? 0;
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const h = hasHeader ? (matrix[0][i] ?? "").trim() : "";
    out.push(h || `欄 ${i + 1}`);
  }
  return out;
}

export function defaultTableTreats(fields: string[]): Treat[] {
  const sug = fields.map((f) => suggestTreat(f));
  const any = sug.some(Boolean);
  return sug.map((s) => s ?? (any ? "none" : "detect"));
}

export function collectJsonKeys(value: unknown, cap = 300): string[] {
  const set = new Set<string>();
  const walk = (v: unknown, key: string) => {
    if (set.size >= cap) return;
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === "string" || typeof v === "number") set.add(key);
  };
  walk(value, "(root)");
  return [...set];
}

export function defaultJsonTreats(keys: string[]): Record<string, Treat> {
  return Object.fromEntries(keys.map((k) => [k, suggestTreat(k) ?? "detect"]));
}

/* ------------------------------ processing ------------------------------ */

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** returns null when cancelled */
export async function processTable(
  data: string[][],
  treats: Treat[],
  engine: Engine,
  isCancelled: () => boolean,
  onProgress?: (p: number) => void,
): Promise<TableResult | null> {
  const rows: string[][] = new Array(data.length);
  const preview = new Map<string, TableCellPreview>();
  let t0 = performance.now();
  for (let r = 0; r < data.length; r++) {
    const src = data[r];
    let out = src;
    for (let c = 0; c < src.length; c++) {
      const treat = treats[c] ?? "none";
      const cell = src[c];
      if (treat === "none" || !cell) continue;
      const res = engine.redact(cell, treat === "detect" ? undefined : (treat as CatId));
      if (res.out !== cell || res.origSpans.length) {
        if (out === src) out = src.slice();
        out[c] = res.out;
        if (r < PREVIEW_ROWS) preview.set(`${r},${c}`, { o: res.origSpans, r: res.outSpans });
      }
    }
    rows[r] = out;
    if (performance.now() - t0 > 14) {
      onProgress?.(r / data.length);
      await tick();
      if (isCancelled()) return null;
      t0 = performance.now();
    }
  }
  onProgress?.(1);
  return { rows, preview };
}

export function processJson(value: unknown, treats: Record<string, Treat>, engine: Engine): JsonResult {
  const walk = (v: unknown, key: string): { o: unknown; r: unknown } => {
    if (Array.isArray(v)) {
      const pairs = v.map((x) => walk(x, key));
      return { o: pairs.map((p) => p.o), r: pairs.map((p) => p.r) };
    }
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      const r: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const p = walk(x, k);
        o[k] = p.o;
        r[k] = p.r;
      }
      return { o, r };
    }
    if (typeof v === "string" || typeof v === "number") {
      const treat = treats[key] ?? "none";
      if (treat === "none") return { o: v, r: v };
      const s = String(v);
      const res = engine.redact(s, treat === "detect" ? undefined : (treat as CatId));
      if (res.origSpans.length === 0) return { o: v, r: v };
      return { o: applyMarks(s, res.origSpans), r: applyMarks(res.out, res.outSpans) };
    }
    return { o: v, r: v };
  };
  const { o, r } = walk(value, "(root)");
  const orig = parseMarks(JSON.stringify(o, null, 2) ?? "");
  const out = parseMarks(JSON.stringify(r, null, 2) ?? "");
  return { origText: orig.plain, origSpans: orig.spans, outText: out.plain, outSpans: out.spans };
}

/* ------------------------------ exporting ------------------------------ */

export function csvBlob(matrix: string[][], delimiter: string): Blob {
  const text = Papa.unparse(matrix, { delimiter, newline: "\r\n" });
  return new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
}

export async function xlsxBlob(matrix: string[][], sheetName: string, bookType: "xlsx" | "biff8" = "xlsx"): Promise<Blob> {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "Sheet1");
  const out = XLSX.write(wb, { bookType, type: "array" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function textBlob(text: string, type = "text/plain"): Blob {
  return new Blob([text], { type: `${type};charset=utf-8` });
}

export function matrixToCsvString(matrix: string[][], delimiter: string): string {
  return Papa.unparse(matrix, { delimiter, newline: "\n" });
}

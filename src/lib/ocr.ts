/**
 * Local OCR helper built on tesseract.js. Runs in a Web Worker created from an in-memory Blob;
 * the worker's fetch() is locked down so only the bundled language data can be loaded.
 */
import { CAT_MAP, createEngine, defaultSettings, type CatId, type RuleSettings } from "./pii";
import { decodeImage, closeDrawable, drawableSize, type Drawable } from "./imageFx";

export type OcrLang = "eng" | "eng+chi_tra";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  rects: (Rect | null)[];
}

export interface OcrHit {
  x: number;
  y: number;
  w: number;
  h: number;
  cat: CatId;
  text: string;
}

type WorkerT = {
  recognize: (image: Blob, opts?: object, output?: object) => Promise<{ data: any }>;
  terminate: () => Promise<unknown>;
  setParameters: (p: object) => Promise<unknown>;
};

let worker: WorkerT | null = null;
let workerLang: OcrLang | null = null;
let urls: string[] = [];
let progressCb: ((p: number, status: string) => void) | null = null;
let starting: Promise<WorkerT> | null = null;

export async function disposeOcr() {
  starting = null;
  const w = worker;
  worker = null;
  workerLang = null;
  progressCb = null;
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  try {
    await w?.terminate();
  } catch {
    /* ignore */
  }
}

async function toBlobUrl(src: string): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const u = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  urls.push(u);
  return u;
}

async function startWorker(lang: OcrLang, onStatus?: (s: string) => void): Promise<WorkerT> {
  onStatus?.("載入本地 OCR 引擎…");
  const [{ createWorker }, { assets }] = await Promise.all([import("tesseract.js"), import("./ocrAssets")]);
  const langUrls: Record<string, string> = { eng: await toBlobUrl(assets.engUrl) };
  if (lang.includes("chi_tra")) langUrls.chi_tra = await toBlobUrl(assets.chiUrl);

  // The core is evaluated inside the worker first (defines global TesseractCore), so no importScripts / CDN is needed.
  const prelude = `
self.__LANG_URLS = ${JSON.stringify(langUrls)};
(function () {
  var realFetch = self.fetch.bind(self);
  self.fetch = function (u, o) {
    var m = /\\/([^\\/]+)\\.traineddata(?:\\.gz)?$/.exec(String(u));
    if (m && self.__LANG_URLS[m[1]]) return realFetch(self.__LANG_URLS[m[1]], o);
    return Promise.reject(new Error("Network access is disabled (offline OCR)"));
  };
})();
`;
  const script = new Blob([prelude, "\n", assets.coreSrc, "\n;\n", assets.workerSrc], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(script);
  urls.push(workerUrl);

  onStatus?.("初始化 OCR 語言模型…");
  const w = (await createWorker(lang.split("+"), 1, {
    workerPath: workerUrl,
    workerBlobURL: false,
    langPath: "https://offline.invalid/lang",
    cacheMethod: "none",
    logger: (m: { progress: number; status: string }) => progressCb?.(m.progress, m.status),
    errorHandler: () => {},
  } as never)) as unknown as WorkerT;
  return w;
}

async function getWorker(lang: OcrLang, onStatus?: (s: string) => void): Promise<WorkerT> {
  if (worker && workerLang === lang) return worker;
  if (worker) await disposeOcr();
  starting ||= startWorker(lang, onStatus);
  try {
    worker = await starting;
    workerLang = lang;
    return worker;
  } catch (e) {
    await disposeOcr();
    throw e;
  } finally {
    starting = null;
  }
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

function lineToChars(line: any): OcrLine {
  let text = "";
  const rects: (Rect | null)[] = [];
  for (const word of line.words ?? []) {
    const wt: string = word.text ?? "";
    if (!wt) continue;
    if (text.length > 0 && !CJK.test(text[text.length - 1]) && !CJK.test(wt[0])) {
      text += " ";
      rects.push(null);
    }
    const syms: any[] | undefined = word.symbols;
    const joined = syms ? syms.map((s) => s.text ?? "").join("") : "";
    if (syms && syms.length && joined === wt) {
      for (const s of syms) for (let k = 0; k < (s.text as string).length; k++) rects.push(s.bbox);
    } else {
      const b = word.bbox as Rect;
      const n = wt.length;
      const wd = b.x1 - b.x0;
      for (let i = 0; i < n; i++) rects.push({ x0: b.x0 + (wd * i) / n, x1: b.x0 + (wd * (i + 1)) / n, y0: b.y0, y1: b.y1 });
    }
    text += wt;
  }
  return { text, rects };
}

function extractLines(data: any): OcrLine[] {
  const lines: any[] = [];
  if (Array.isArray(data.blocks)) {
    for (const b of data.blocks) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) lines.push(l);
  } else if (Array.isArray(data.lines)) {
    lines.push(...data.lines);
  } else if (Array.isArray(data.words)) {
    lines.push({ words: data.words });
  }
  return lines.map(lineToChars).filter((l) => l.text.trim().length > 0);
}

export interface OcrScanResult {
  lines: OcrLine[];
  scale: number;
}

export async function ocrScanFile(
  file: Blob,
  lang: OcrLang,
  onProgress?: (p: number, status: string) => void,
  onStatus?: (s: string) => void,
): Promise<OcrScanResult> {
  const w = await getWorker(lang, onStatus);
  progressCb = onProgress ?? null;
  const src: Drawable = await decodeImage(file);
  let blob: Blob;
  let scale = 1;
  try {
    const { w: iw, h: ih } = drawableSize(src);
    const longest = Math.max(iw, ih);
    scale = longest < 1600 ? Math.min(2, 3200 / longest) : Math.min(1, 3200 / longest);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(iw * scale));
    c.height = Math.max(1, Math.round(ih * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    c.width = 0;
    c.height = 0;
    if (!b) throw new Error("無法準備 OCR 影像");
    blob = b;
  } finally {
    closeDrawable(src);
  }
  onStatus?.("辨識文字中…");
  const { data } = await w.recognize(blob, {}, { blocks: true, text: true });
  return { lines: extractLines(data), scale };
}

export interface OcrDetectOptions {
  cats: Partial<Record<CatId, boolean>>;
  keywords: string;
  ignoreCase: boolean;
}

export function findHits(res: OcrScanResult, opt: OcrDetectOptions): OcrHit[] {
  const s: RuleSettings = defaultSettings();
  for (const k of Object.keys(s.enabled) as CatId[]) s.enabled[k] = !!opt.cats[k];
  s.enabled.keyword = !!opt.keywords.trim();
  s.enabled.regex = false;
  s.keywords = opt.keywords;
  s.keywordIgnoreCase = opt.ignoreCase;
  const engine = createEngine(s);
  const hits: OcrHit[] = [];
  const pad = 3;
  for (const line of res.lines) {
    for (const span of engine.detect(line.text)) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = span.start; i < span.end; i++) {
        const r = line.rects[i];
        if (!r) continue;
        x0 = Math.min(x0, r.x0);
        y0 = Math.min(y0, r.y0);
        x1 = Math.max(x1, r.x1);
        y1 = Math.max(y1, r.y1);
      }
      if (!isFinite(x0)) continue;
      hits.push({
        x: (x0 - pad) / res.scale,
        y: (y0 - pad) / res.scale,
        w: (x1 - x0 + pad * 2) / res.scale,
        h: (y1 - y0 + pad * 2) / res.scale,
        cat: span.cat,
        text: line.text.slice(span.start, span.end),
      });
    }
  }
  return hits;
}

export const hitLabel = (cat: CatId) => CAT_MAP[cat].label;

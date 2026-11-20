/**
 * Image redaction rendering. Everything runs on <canvas> in the browser.
 *  - pixelate  : block average (non-reversible mosaic)
 *  - blur      : 3-pass box blur (~gaussian), computed in JS so it works in every browser
 *  - solid     : opaque fill with optional text label
 * Exporting always re-draws pixels onto a fresh canvas, which drops EXIF / GPS / device metadata.
 */

export type Drawable = ImageBitmap | HTMLImageElement;

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** OCR suggestion waiting for user confirmation */
  suggested?: boolean;
  reason?: string;
}

export type StyleKind = "pixelate" | "blur" | "solid";

export interface StyleCfg {
  kind: StyleKind;
  pixel: number;
  blur: number;
  color: string;
  label: string;
  /** scale pixel / blur strength with image resolution so large photos are masked as strongly as small screenshots */
  autoScale: boolean;
}

export const defaultStyleCfg: StyleCfg = {
  kind: "pixelate",
  pixel: 12,
  blur: 14,
  color: "#000000",
  label: "",
  autoScale: true,
};

export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 150_000_000;

export function drawableSize(d: Drawable): { w: number; h: number } {
  return d instanceof HTMLImageElement ? { w: d.naturalWidth, h: d.naturalHeight } : { w: d.width, h: d.height };
}

export async function decodeImage(file: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function closeDrawable(d: Drawable | null | undefined) {
  if (d && !(d instanceof HTMLImageElement)) d.close();
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

export async function makeThumb(d: Drawable, maxSide = 240): Promise<string> {
  const { w, h } = drawableSize(d);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(Math.round(w * s), Math.round(h * s));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(d, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.8));
  releaseCanvas(c);
  if (!blob) throw new Error("thumb failed");
  return URL.createObjectURL(blob);
}

/* ------------------------------ effects ------------------------------ */

export function resolveStrength(cfg: StyleCfg, iw: number, ih: number) {
  const f = cfg.autoScale ? Math.max(1, Math.max(iw, ih) / 1200) : 1;
  return { pixel: Math.max(2, Math.round(cfg.pixel * f)), blur: Math.max(1, Math.round(cfg.blur * f)) };
}

function pixelate(img: ImageData, b: number) {
  const { width: w, height: h, data } = img;
  for (let y0 = 0; y0 < h; y0 += b) {
    const y1 = Math.min(h, y0 + b);
    for (let x0 = 0; x0 < w; x0 += b) {
      const x1 = Math.min(w, x0 + b);
      let r = 0,
        g = 0,
        bl = 0,
        a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          bl += data[i + 2];
          a += data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      r = Math.round(r / n);
      g = Math.round(g / n);
      bl = Math.round(bl / n);
      a = Math.round(a / n);
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = bl;
          data[i + 3] = a;
        }
      }
    }
  }
}

function blurPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number, horiz: boolean) {
  const len = horiz ? w : h;
  const lines = horiz ? h : w;
  const stride = horiz ? 4 : 4 * w;
  const lineStride = horiz ? 4 * w : 4;
  const win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const i = k < 0 ? 0 : k >= len ? len - 1 : k;
        sum += src[base + i * stride + c];
      }
      for (let x = 0; x < len; x++) {
        dst[base + x * stride + c] = sum / win;
        const add = x + r + 1;
        const rem = x - r;
        sum += src[base + (add >= len ? len - 1 : add) * stride + c] - src[base + (rem < 0 ? 0 : rem) * stride + c];
      }
    }
  }
}

function boxBlur(img: ImageData, r: number) {
  const a = img.data;
  const b = new Uint8ClampedArray(a.length);
  for (let i = 0; i < 3; i++) {
    blurPass(a, b, img.width, img.height, r, true);
    blurPass(b, a, img.width, img.height, r, false);
  }
}

function contrastColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? "#000000" : "#ffffff";
}

function drawLabel(ctx: CanvasRenderingContext2D, label: string, color: string, cw: number, ch: number) {
  const text = label.trim();
  if (!text) return;
  const family = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
  ctx.font = `700 100px ${family}`;
  const tw = ctx.measureText(text).width || 1;
  const size = Math.max(4, Math.min(ch * 0.62, (cw * 0.92 * 100) / tw));
  ctx.font = `700 ${size}px ${family}`;
  ctx.fillStyle = contrastColor(color);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cw / 2, ch / 2 + size * 0.04);
}

/**
 * Render the redaction for one box at resolution `rs` (output px per image px).
 * rs = 1 for export, < 1 for zoomed-out previews.
 */
export function renderBoxEffect(src: Drawable, box: Box, cfg: StyleCfg, iw: number, ih: number, rs: number): HTMLCanvasElement {
  const cw = Math.max(1, Math.round(box.w * rs));
  const ch = Math.max(1, Math.round(box.h * rs));
  const c = makeCanvas(cw, ch);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  if (cfg.kind === "solid") {
    ctx.fillStyle = cfg.color;
    ctx.fillRect(0, 0, cw, ch);
    drawLabel(ctx, cfg.label, cfg.color, cw, ch);
    return c;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
  const st = resolveStrength(cfg, iw, ih);
  const img = ctx.getImageData(0, 0, cw, ch);
  if (cfg.kind === "pixelate") pixelate(img, Math.max(1, Math.round(st.pixel * rs)));
  else boxBlur(img, Math.max(1, Math.round(st.blur * rs)));
  ctx.putImageData(img, 0, 0);
  return c;
}

export function clampBox(b: Box, iw: number, ih: number): Box {
  const x = Math.max(0, Math.min(iw - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(ih - 1, Math.round(b.y)));
  const w = Math.max(1, Math.min(iw - x, Math.round(b.w)));
  const h = Math.max(1, Math.min(ih - y, Math.round(b.h)));
  return { ...b, x, y, w, h };
}

/* ------------------------------ export ------------------------------ */

export type ExportFormat = "png" | "jpeg";

export function renderFull(
  src: Drawable,
  boxes: Box[],
  cfg: StyleCfg,
  opaque: boolean,
): { canvas: HTMLCanvasElement; downscaled: boolean } {
  const { w, h } = drawableSize(src);
  let s = 1;
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) s = Math.min(s, MAX_CANVAS_SIDE / Math.max(w, h));
  if (w * h * s * s > MAX_CANVAS_AREA) s = Math.min(s, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  const cw = Math.round(w * s);
  const ch = Math.round(h * s);
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext("2d")!;
  if (opaque) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, cw, ch);
  for (const b of boxes) {
    if (b.suggested) continue;
    const box = clampBox(b, w, h);
    const fx = renderBoxEffect(src, box, cfg, w, h, s);
    ctx.drawImage(fx, Math.round(box.x * s), Math.round(box.y * s), Math.max(1, Math.round(box.w * s)), Math.max(1, Math.round(box.h * s)));
    releaseCanvas(fx);
  }
  return { canvas, downscaled: s < 1 };
}

export async function exportImage(
  file: Blob,
  boxes: Box[],
  cfg: StyleCfg,
  format: ExportFormat,
  quality: number,
): Promise<{ blob: Blob; downscaled: boolean }> {
  const src = await decodeImage(file);
  try {
    const { canvas, downscaled } = renderFull(src, boxes, cfg, format === "jpeg");
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, format === "png" ? "image/png" : "image/jpeg", quality));
    releaseCanvas(canvas);
    if (!blob) throw new Error("圖片尺寸過大，瀏覽器無法匯出");
    return { blob, downscaled };
  } finally {
    closeDrawable(src);
  }
}

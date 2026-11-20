import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageCanvas, type CanvasHandle } from "./ImageCanvas";
import { Btn, ProgressBar, Section, Slider, Switch, inputCls, useToast } from "./ui";
import { PresetBar } from "./PresetBar";
import {
  clampBox,
  closeDrawable,
  decodeImage,
  defaultStyleCfg,
  drawableSize,
  exportImage,
  makeThumb,
  type Box,
  type Drawable,
  type ExportFormat,
  type StyleCfg,
  type StyleKind,
} from "@/lib/imageFx";
import { downloadBlob, redactedName, tick, uid } from "@/lib/files";
import { loadPrefs, loadPresets, savePrefs, savePresets, type Preset } from "@/lib/storage";
import { CAT_MAP, type CatId } from "@/lib/pii";
import { disposeOcr, findHits, ocrScanFile, type OcrLang } from "@/lib/ocr";
import { cn } from "@/utils/cn";

interface ImageItem {
  id: string;
  name: string;
  file: File;
  thumb: string;
  width: number;
  height: number;
  boxes: Box[];
  past: Box[][];
  future: Box[][];
}

const OCR_CATS: CatId[] = ["phone", "email", "id", "bank", "ip", "url"];

interface OcrOpts {
  cats: Partial<Record<CatId, boolean>>;
  keywords: string;
  ignoreCase: boolean;
  lang: OcrLang;
}

interface ImagePrefs {
  imageStyle: StyleCfg;
  imageFormat: ExportFormat;
  imageQuality: number;
  imageOcr: Omit<OcrOpts, "keywords">;
}

interface ImagePresetData {
  style: StyleCfg;
  ocr: Omit<OcrOpts, "keywords"> & { keywords?: string };
}

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];
const isImage = (f: File) => ACCEPT.includes(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);

const SWATCHES = [
  { c: "#000000", n: "黑條" },
  { c: "#ffffff", n: "白條" },
  { c: "#dc2626", n: "紅" },
  { c: "#1d4ed8", n: "藍" },
];

export function ImageRedactor({ active: tabActive }: { active: boolean }) {
  const notify = useToast();
  const prefs = useMemo(
    () =>
      loadPrefs<ImagePrefs>({
        imageStyle: defaultStyleCfg,
        imageFormat: "png",
        imageQuality: 0.92,
        imageOcr: { cats: { phone: true, email: true }, ignoreCase: true, lang: "eng" },
      }),
    [],
  );

  const [items, setItems] = useState<ImageItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<StyleCfg>({ ...defaultStyleCfg, ...prefs.imageStyle });
  const [format, setFormat] = useState<ExportFormat>(prefs.imageFormat);
  const [quality, setQuality] = useState(prefs.imageQuality);
  const [tool, setTool] = useState<"draw" | "pan">("draw");
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<Drawable | null>(null);
  const [skipEmpty, setSkipEmpty] = useState(false);
  const [exporting, setExporting] = useState<{ p: number; label: string } | null>(null);
  const [ocrBusy, setOcrBusy] = useState<{ p: number; label: string } | null>(null);
  const [ocr, setOcr] = useState<OcrOpts>({
    cats: prefs.imageOcr?.cats ?? { phone: true, email: true },
    keywords: "",
    ignoreCase: prefs.imageOcr?.ignoreCase ?? true,
    lang: prefs.imageOcr?.lang ?? "eng",
  });
  const [presets, setPresets] = useState<Preset<ImagePresetData>[]>(() => loadPresets<ImagePresetData>("image"));

  const canvasRef = useRef<CanvasHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const active = items.find((i) => i.id === activeId) ?? null;
  const activeRef = useRef(active);
  activeRef.current = active;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  /* ---------- preferences (style only – never image data) ---------- */
  useEffect(() => {
    savePrefs({ imageStyle: cfg, imageFormat: format, imageQuality: quality, imageOcr: { cats: ocr.cats, ignoreCase: ocr.ignoreCase, lang: ocr.lang } });
  }, [cfg, format, quality, ocr.cats, ocr.ignoreCase, ocr.lang]);

  /* ---------- cleanup on unmount / wipe ---------- */
  useEffect(
    () => () => {
      itemsRef.current.forEach((i) => URL.revokeObjectURL(i.thumb));
      void disposeOcr();
    },
    [],
  );

  /* ---------- decode the active image (only one full bitmap is kept in memory) ---------- */
  const activeFileId = active?.id ?? null;
  useEffect(() => {
    const it = itemsRef.current.find((i) => i.id === activeFileId);
    setSource(null);
    if (!it) return;
    let cancelled = false;
    let d: Drawable | null = null;
    decodeImage(it.file)
      .then((x) => {
        if (cancelled) return closeDrawable(x);
        d = x;
        setSource(x);
      })
      .catch(() => notify("無法解碼此圖片", "error"));
    return () => {
      cancelled = true;
      const old = d;
      setTimeout(() => closeDrawable(old), 400);
    };
  }, [activeFileId, notify]);

  /* ---------- items helpers ---------- */
  const mutate = useCallback((id: string, fn: (it: ImageItem) => ImageItem) => {
    setItems((prev) => prev.map((it) => (it.id === id ? fn(it) : it)));
  }, []);

  const commitBoxes = useCallback(
    (id: string, boxes: Box[]) => mutate(id, (it) => ({ ...it, boxes, past: [...it.past.slice(-99), it.boxes], future: [] })),
    [mutate],
  );

  const undo = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    mutate(a.id, (it) =>
      it.past.length ? { ...it, boxes: it.past[it.past.length - 1], past: it.past.slice(0, -1), future: [it.boxes, ...it.future] } : it,
    );
  }, [mutate]);

  const redo = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    mutate(a.id, (it) => (it.future.length ? { ...it, boxes: it.future[0], future: it.future.slice(1), past: [...it.past, it.boxes] } : it));
  }, [mutate]);

  const deleteSelected = useCallback(() => {
    const a = activeRef.current;
    const sel = selectedRef.current;
    if (!a || !sel) return;
    commitBoxes(a.id, a.boxes.filter((b) => b.id !== sel));
    setSelectedId(null);
  }, [commitBoxes]);

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    if (!tabActive) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedRef.current) {
          e.preventDefault();
          deleteSelected();
        }
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key.startsWith("Arrow") && selectedRef.current && activeRef.current) {
        e.preventDefault();
        const a = activeRef.current;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commitBoxes(
          a.id,
          a.boxes.map((b) =>
            b.id === selectedRef.current ? { ...b, x: Math.max(0, Math.min(a.width - b.w, b.x + dx)), y: Math.max(0, Math.min(a.height - b.h, b.y + dy)) } : b,
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabActive, undo, redo, deleteSelected, commitBoxes]);

  /* ---------- adding files ---------- */
  const addFiles = useCallback(
    async (files: File[]) => {
      const valid = files.filter(isImage);
      const skipped = files.length - valid.length;
      if (skipped) notify(`已略過 ${skipped} 個非 PNG / JPG / WEBP 檔案`, "error");
      if (!valid.length) return;
      setLoading({ done: 0, total: valid.length });
      let failed = 0;
      for (let i = 0; i < valid.length; i++) {
        const f = valid[i];
        try {
          const d = await decodeImage(f);
          const { w, h } = drawableSize(d);
          const thumb = await makeThumb(d);
          closeDrawable(d);
          const item: ImageItem = { id: uid(), name: f.name, file: f, thumb, width: w, height: h, boxes: [], past: [], future: [] };
          setItems((prev) => [...prev, item]);
          setActiveId((cur) => cur ?? item.id);
        } catch {
          failed++;
        }
        setLoading({ done: i + 1, total: valid.length });
        await tick();
      }
      setLoading(null);
      if (failed) notify(`${failed} 張圖片無法讀取（檔案損毀或格式不支援）`, "error");
    },
    [notify],
  );

  const removeItem = (id: string) => {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      const it = prev[idx];
      if (it) URL.revokeObjectURL(it.thumb);
      const next = prev.filter((i) => i.id !== id);
      if (id === activeRef.current?.id) setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null);
      return next;
    });
    setSelectedId(null);
  };

  const clearAll = () => {
    items.forEach((i) => URL.revokeObjectURL(i.thumb));
    setItems([]);
    setActiveId(null);
    setSelectedId(null);
  };

  /* ---------- drag & drop ---------- */
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void addFiles(Array.from(e.dataTransfer.files));
    },
  };

  /* ---------- apply boxes to all ---------- */
  const applyToAll = () => {
    const a = activeRef.current;
    if (!a) return;
    const src = a.boxes.filter((b) => !b.suggested);
    if (!src.length) return notify("目前圖片沒有已確認的遮蔽框", "error");
    const others = items.filter((i) => i.id !== a.id);
    if (!others.length) return notify("沒有其他圖片可套用", "error");
    others.forEach((o) => {
      const sx = o.width / a.width;
      const sy = o.height / a.height;
      const boxes = src.map((b) => clampBox({ id: uid(), x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy }, o.width, o.height));
      commitBoxes(o.id, boxes);
    });
    notify(`已將 ${src.length} 個遮蔽框複製到其他 ${others.length} 張圖片（可逐張 Undo）`, "success");
  };

  /* ---------- OCR ---------- */
  const runOcr = async (targets: ImageItem[]) => {
    if (!targets.length || ocrBusy) return;
    const enabledCats = OCR_CATS.some((c) => ocr.cats[c]);
    if (!enabledCats && !ocr.keywords.trim()) return notify("請至少選擇一種偵測類型或輸入關鍵字", "error");
    setOcrBusy({ p: 0, label: "準備中…" });
    let total = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const it = targets[i];
        const prefix = targets.length > 1 ? `(${i + 1}/${targets.length}) ` : "";
        const res = await ocrScanFile(
          it.file,
          ocr.lang,
          (p, st) => setOcrBusy({ p: (i + Math.max(0, Math.min(1, p))) / targets.length, label: `${prefix}${st}` }),
          (st) => setOcrBusy((cur) => ({ p: cur?.p ?? 0, label: `${prefix}${st}` })),
        );
        const hits = findHits(res, ocr);
        const cur = itemsRef.current.find((x) => x.id === it.id);
        if (!cur) continue;
        const confirmed = cur.boxes.filter((b) => !b.suggested);
        const sugg: Box[] = [];
        for (const h of hits) {
          const nb = clampBox({ id: uid(), x: h.x, y: h.y, w: h.w, h: h.h, suggested: true, reason: `${CAT_MAP[h.cat].label}：${h.text}` }, it.width, it.height);
          const covered = confirmed.some((c) => {
            const ix = Math.max(0, Math.min(c.x + c.w, nb.x + nb.w) - Math.max(c.x, nb.x));
            const iy = Math.max(0, Math.min(c.y + c.h, nb.y + nb.h) - Math.max(c.y, nb.y));
            return ix * iy >= nb.w * nb.h * 0.8;
          });
          if (!covered) sugg.push(nb);
        }
        total += sugg.length;
        commitBoxes(it.id, [...confirmed, ...sugg]);
      }
      notify(total ? `OCR 完成：找到 ${total} 個建議遮蔽框（橘色虛線），請確認後套用` : "OCR 完成：未找到符合的敏感資料", total ? "success" : "info");
    } catch (e) {
      notify(`OCR 失敗：${(e as Error)?.message ?? e}`, "error");
    } finally {
      setOcrBusy(null);
    }
  };

  const acceptSuggestions = (ids?: string[]) => {
    const a = activeRef.current;
    if (!a) return;
    commitBoxes(a.id, a.boxes.map((b) => (b.suggested && (!ids || ids.includes(b.id)) ? { ...b, suggested: false, reason: undefined } : b)));
  };
  const dismissSuggestions = (ids?: string[]) => {
    const a = activeRef.current;
    if (!a) return;
    commitBoxes(a.id, a.boxes.filter((b) => !(b.suggested && (!ids || ids.includes(b.id)))));
  };

  /* ---------- export ---------- */
  const ext = format === "png" ? "png" : "jpg";
  const pendingSuggestions = items.reduce((n, i) => n + i.boxes.filter((b) => b.suggested).length, 0);

  const exportCurrent = async () => {
    if (!active) return;
    setExporting({ p: 0.3, label: "輸出中…" });
    try {
      const { blob, downscaled } = await exportImage(active.file, active.boxes, cfg, format, quality);
      downloadBlob(blob, redactedName(active.name, ext, new Set()));
      notify(downscaled ? "已匯出（原圖超出瀏覽器 Canvas 上限，已等比縮小）" : "已匯出（已剝除 EXIF / GPS 等 Metadata）", "success");
    } catch (e) {
      notify(`匯出失敗：${(e as Error).message}`, "error");
    } finally {
      setExporting(null);
    }
  };

  const exportZip = async () => {
    const list = skipEmpty ? items.filter((i) => i.boxes.some((b) => !b.suggested)) : items;
    if (!list.length) return notify("沒有可匯出的圖片", "error");
    setExporting({ p: 0, label: "準備打包…" });
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const used = new Set<string>();
      let down = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        setExporting({ p: (i / list.length) * 0.85, label: `處理圖片 ${i + 1} / ${list.length}：${it.name}` });
        await tick();
        const { blob, downscaled } = await exportImage(it.file, it.boxes, cfg, format, quality);
        if (downscaled) down++;
        zip.file(redactedName(it.name, ext, used), blob, { binary: true });
      }
      const out = await zip.generateAsync({ type: "blob", compression: "STORE" }, (m) =>
        setExporting({ p: 0.85 + (m.percent / 100) * 0.15, label: `壓縮打包中… ${m.percent.toFixed(0)}%` }),
      );
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      downloadBlob(out, `redacted_images_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`);
      notify(`已打包 ${list.length} 張圖片${down ? `（其中 ${down} 張超大圖片已等比縮小）` : ""}`, "success");
    } catch (e) {
      notify(`打包失敗：${(e as Error).message}`, "error");
    } finally {
      setExporting(null);
    }
  };

  /* ---------- presets ---------- */
  const savePreset = (name: string, includeKw: boolean) => {
    const p: Preset<ImagePresetData> = {
      id: uid(),
      name,
      createdAt: Date.now(),
      data: { style: cfg, ocr: { cats: ocr.cats, ignoreCase: ocr.ignoreCase, lang: ocr.lang, ...(includeKw ? { keywords: ocr.keywords } : {}) } },
    };
    const next = [...presets, p];
    setPresets(next);
    savePresets("image", next);
    notify(`已儲存 Preset「${name}」`, "success");
  };
  const applyPreset = (p: Preset<ImagePresetData>) => {
    setCfg({ ...defaultStyleCfg, ...p.data.style });
    setOcr((o) => ({
      cats: p.data.ocr?.cats ?? o.cats,
      ignoreCase: p.data.ocr?.ignoreCase ?? o.ignoreCase,
      lang: p.data.ocr?.lang ?? o.lang,
      keywords: p.data.ocr?.keywords ?? o.keywords,
    }));
    notify(`已套用 Preset「${p.name}」`, "success");
  };
  const deletePreset = (id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    savePresets("image", next);
  };

  /* ---------- derived ---------- */
  const confirmed = active ? active.boxes.filter((b) => !b.suggested) : [];
  const suggested = active ? active.boxes.filter((b) => b.suggested) : [];
  const set = <K extends keyof StyleCfg>(k: K, v: StyleCfg[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const kinds: { id: StyleKind; label: string }[] = [
    { id: "pixelate", label: "馬賽克" },
    { id: "blur", label: "高斯模糊" },
    { id: "solid", label: "純色遮蓋" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" {...dropHandlers}>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {/* ---------------- thumbnails ---------------- */}
      <aside className="flex max-h-44 shrink-0 flex-row border-b border-slate-300 bg-white transition-colors dark:border-slate-800 dark:bg-slate-900 lg:max-h-none lg:w-44 lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex shrink-0 flex-col gap-1.5 border-slate-300 p-2 dark:border-slate-800 lg:border-b">
          <Btn variant="primary" size="sm" onClick={() => fileInput.current?.click()}>
            ＋ 選取圖片
          </Btn>
          <Btn size="sm" variant="danger" disabled={!items.length} onClick={clearAll}>
            清空全部
          </Btn>
          <div className="hidden text-center text-[11px] text-slate-700 dark:text-slate-300 lg:block">{items.length} 張圖片</div>
        </div>
        <div className="flex min-h-0 flex-1 flex-row gap-2 overflow-auto p-2 lg:flex-col">
          {items.map((it) => {
            const n = it.boxes.filter((b) => !b.suggested).length;
            const s = it.boxes.length - n;
            return (
              <div
                key={it.id}
                className={cn(
                  "group relative w-28 shrink-0 cursor-pointer rounded-md border-2 bg-slate-100 p-1 transition-colors dark:bg-slate-800 lg:w-full",
                  it.id === activeId
                    ? "border-blue-700 bg-blue-50 dark:border-blue-500 dark:bg-blue-950"
                    : "border-transparent hover:border-slate-400 dark:hover:border-slate-600",
                )}
                onClick={() => {
                  setActiveId(it.id);
                  setSelectedId(null);
                }}
              >
                <img src={it.thumb} alt={it.name} className="h-20 w-full rounded bg-slate-300 object-contain dark:bg-slate-700" draggable={false} />
                <div className="mt-1 truncate text-[11px] font-medium text-slate-900 dark:text-slate-100" title={it.name}>
                  {it.name}
                </div>
                <div className="flex gap-1 text-[10px] text-slate-700 dark:text-slate-400">
                  <span>{it.width}×{it.height}</span>
                </div>
                {(n > 0 || s > 0) && (
                  <div className="absolute top-1.5 left-1.5 flex gap-1">
                    {n > 0 && <span className="rounded bg-blue-700 px-1 text-[10px] font-bold text-white">{n}</span>}
                    {s > 0 && <span className="rounded bg-amber-500 px-1 text-[10px] font-bold text-black">{s}?</span>}
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`移除 ${it.name}`}
                  title="移除此圖片"
                  className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-700 text-xs font-bold text-white group-hover:flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeItem(it.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {loading && (
            <div className="w-28 shrink-0 p-1 lg:w-full">
              <ProgressBar value={loading.done / loading.total} label={`讀取 ${loading.done}/${loading.total}`} />
            </div>
          )}
        </div>
      </aside>

      {/* ---------------- canvas ---------------- */}
      <main className="relative flex min-h-[420px] min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-300 bg-white px-2 py-1.5 transition-colors dark:border-slate-800 dark:bg-slate-900">
          <Btn size="sm" active={tool === "draw"} onClick={() => setTool("draw")} title="拖拉建立／選取／移動／縮放遮蔽框">
            ▭ 畫框
          </Btn>
          <Btn size="sm" active={tool === "pan"} onClick={() => setTool("pan")} title="拖曳平移畫面（亦可按住空白鍵或滑鼠中鍵）">
            ✋ 平移
          </Btn>
          <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-700" />
          <Btn size="sm" disabled={!active?.past.length} onClick={undo} title="復原 (Ctrl+Z)">
            ↶ Undo
          </Btn>
          <Btn size="sm" disabled={!active?.future.length} onClick={redo} title="重做 (Ctrl+Y)">
            ↷ Redo
          </Btn>
          <Btn size="sm" variant="danger" disabled={!selectedId} onClick={deleteSelected} title="刪除選取的框 (Delete)">
            🗑 刪除框
          </Btn>
          <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-700" />
          <Btn size="sm" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)} aria-label="縮小">
            －
          </Btn>
          <span className="w-12 text-center font-mono text-xs font-bold text-slate-900 dark:text-slate-100">{Math.round(zoom * 100)}%</span>
          <Btn size="sm" onClick={() => canvasRef.current?.zoomBy(1.25)} aria-label="放大">
            ＋
          </Btn>
          <Btn size="sm" onClick={() => canvasRef.current?.fit()}>
            適合視窗
          </Btn>
          <Btn size="sm" onClick={() => canvasRef.current?.actual()}>
            100%
          </Btn>
          <span className="ml-auto hidden text-[11px] text-slate-700 dark:text-slate-400 xl:inline">拖曳畫框 · 滾輪縮放 · 空白鍵／中鍵平移 · 方向鍵微調 · Del 刪除</span>
        </div>

        <div className="relative min-h-0 flex-1">
          {active ? (
            <ImageCanvas
              ref={canvasRef}
              itemId={active.id}
              source={source}
              iw={active.width}
              ih={active.height}
              boxes={active.boxes}
              cfg={cfg}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCommit={(b) => commitBoxes(active.id, b)}
              tool={tool}
              onZoom={setZoom}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-100 p-8 text-center transition-colors dark:bg-slate-950">
              <div className="rounded-xl border-2 border-dashed border-slate-500 bg-white px-10 py-12 transition-colors dark:border-slate-600 dark:bg-slate-900">
                <div className="text-4xl">🖼️</div>
                <p className="mt-3 text-lg font-bold text-slate-900 dark:text-slate-100">拖放圖片到此處</p>
                <p className="mt-1 text-sm text-slate-700 dark:text-slate-400">支援 PNG / JPG / WEBP，可一次加入多張。圖片只會在本機瀏覽器記憶體中處理。</p>
                <Btn variant="primary" className="mt-4" onClick={() => fileInput.current?.click()}>
                  選取圖片…
                </Btn>
              </div>
            </div>
          )}
          {active && !source && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-700/70 text-sm font-bold text-white">解碼圖片中…</div>}
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-4 border-dashed border-blue-500 bg-blue-900/60 text-xl font-bold text-white">
              放開以加入圖片
            </div>
          )}
        </div>
        {active && (
          <div className="flex items-center gap-3 border-t border-slate-300 bg-white px-3 py-1 text-xs text-slate-800 transition-colors dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
            <span className="truncate font-medium">{active.name}</span>
            <span className="font-mono">
              {active.width} × {active.height}px
            </span>
            <span>遮蔽框 {confirmed.length}</span>
            {suggested.length > 0 && <span className="font-bold text-amber-700 dark:text-amber-400">待確認 {suggested.length}</span>}
          </div>
        )}
      </main>

      {/* ---------------- side panel ---------------- */}
      <aside className="w-full shrink-0 overflow-y-auto border-t border-slate-300 bg-white transition-colors dark:border-slate-800 dark:bg-slate-900 lg:w-80 lg:border-t-0 lg:border-l">
        <Section title="遮蔽樣式">
          <div className="mb-3 grid grid-cols-3 gap-1">
            {kinds.map((k) => (
              <Btn key={k.id} size="sm" active={cfg.kind === k.id} onClick={() => set("kind", k.id)}>
                {k.label}
              </Btn>
            ))}
          </div>
          {cfg.kind === "pixelate" && <Slider label="馬賽克方格粗細" value={cfg.pixel} min={4} max={60} onChange={(v) => set("pixel", v)} unit="px" />}
          {cfg.kind === "blur" && <Slider label="模糊強度" value={cfg.blur} min={3} max={60} onChange={(v) => set("blur", v)} unit="px" />}
          {cfg.kind === "solid" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {SWATCHES.map((s) => (
                  <button
                    key={s.c}
                    type="button"
                    title={s.n}
                    aria-label={s.n}
                    onClick={() => set("color", s.c)}
                    className={cn(
                      "h-7 w-7 rounded border-2",
                      cfg.color.toLowerCase() === s.c
                        ? "border-blue-700 ring-2 ring-blue-300 dark:border-blue-500 dark:ring-blue-800"
                        : "border-slate-400 dark:border-slate-600",
                    )}
                    style={{ background: s.c }}
                  />
                ))}
                <label className="ml-1 flex items-center gap-1 text-xs font-medium text-slate-800 dark:text-slate-200">
                  自訂
                  <input type="color" value={cfg.color} onChange={(e) => set("color", e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-slate-400 dark:border-slate-600" />
                </label>
              </div>
              <input className={inputCls} placeholder="文字標籤（可留空），例如 REDACTED" value={cfg.label} onChange={(e) => set("label", e.target.value)} />
              <div className="flex flex-wrap gap-1">
                {["REDACTED", "已遮蔽", "CONFIDENTIAL"].map((l) => (
                  <Btn key={l} size="sm" variant="ghost" className="border-slate-300! dark:border-slate-600!" onClick={() => set("label", l)}>
                    {l}
                  </Btn>
                ))}
              </div>
            </div>
          )}
          {cfg.kind !== "solid" && (
            <div className="mt-3">
              <Switch
                checked={cfg.autoScale}
                onChange={(v) => set("autoScale", v)}
                label="依解像度自動放大強度"
                title="高解像度相片會自動加大方格／模糊半徑，避免遮蔽不足"
              />
              <p className="mt-1 text-[11px] leading-snug text-slate-700 dark:text-slate-400">馬賽克以方格平均色計算（不可逆）；高斯模糊僅使用框內像素。要最高安全性建議用純色遮蓋。</p>
            </div>
          )}
        </Section>

        <Section
          title={`遮蔽框（${confirmed.length}）`}
          right={
            <Btn size="sm" variant="primary" disabled={!active || items.length < 2 || !confirmed.length} onClick={applyToAll} title="將目前圖片的遮蔽框複製到所有其他圖片（按比例換算位置，覆蓋其現有框）">
              複製套用至全部
            </Btn>
          }
        >
          {confirmed.length === 0 ? (
            <p className="text-xs text-slate-700 dark:text-slate-400">在畫布上拖拉滑鼠建立遮蔽框。點選框可移動，拖曳角落／邊緣可調整大小。</p>
          ) : (
            <ul className="max-h-36 space-y-1 overflow-auto">
              {confirmed.map((b, i) => (
                <li
                  key={b.id}
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded border px-2 py-1 text-xs transition-colors",
                    b.id === selectedId
                      ? "border-blue-700 bg-blue-50 font-bold dark:border-blue-500 dark:bg-blue-950"
                      : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800",
                  )}
                  onClick={() => setSelectedId(b.id)}
                >
                  <span>
                    #{i + 1} <span className="font-mono text-slate-700 dark:text-slate-300">{b.w}×{b.h} @ {b.x},{b.y}</span>
                  </span>
                  <button
                    type="button"
                    className="rounded px-1 font-bold text-red-700 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950"
                    aria-label="刪除此框"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (active) commitBoxes(active.id, active.boxes.filter((x) => x.id !== b.id));
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="本地 OCR 半自動偵測">
          <p className="mb-2 text-xs leading-snug text-slate-700 dark:text-slate-400">使用 tesseract.js 於瀏覽器本地執行（模型已內建，不連網）。偵測結果只會成為「建議框」，需你確認。</p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {OCR_CATS.map((c) => (
              <label
                key={c}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold select-none transition-colors",
                  ocr.cats[c]
                    ? "border-blue-700 bg-blue-700 text-white dark:border-blue-500 dark:bg-blue-600"
                    : "border-slate-400 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
                )}
              >
                <input type="checkbox" className="sr-only" checked={!!ocr.cats[c]} onChange={(e) => setOcr((o) => ({ ...o, cats: { ...o.cats, [c]: e.target.checked } }))} />
                {CAT_MAP[c].label.split("／")[0]}
              </label>
            ))}
          </div>
          <textarea
            className={cn(inputCls, "h-16 resize-y")}
            placeholder="自訂關鍵字（每行一個），例如公司名、人名"
            value={ocr.keywords}
            onChange={(e) => setOcr((o) => ({ ...o, keywords: e.target.value }))}
          />
          <div className="mt-2 flex items-center gap-2">
            <select className={inputCls} value={ocr.lang} onChange={(e) => setOcr((o) => ({ ...o, lang: e.target.value as OcrLang }))} aria-label="OCR 語言">
              <option value="eng">英文／數字（較快）</option>
              <option value="eng+chi_tra">英文＋繁體中文（較慢）</option>
            </select>
          </div>
          <div className="mt-2">
            <Switch checked={ocr.ignoreCase} onChange={(v) => setOcr((o) => ({ ...o, ignoreCase: v }))} label="關鍵字不分大小寫" />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Btn variant="primary" size="sm" disabled={!active || !!ocrBusy} onClick={() => active && runOcr([active])}>
              掃描目前圖片
            </Btn>
            <Btn size="sm" disabled={!items.length || !!ocrBusy} onClick={() => runOcr(items)}>
              掃描全部圖片
            </Btn>
          </div>
          {ocrBusy && (
            <div className="mt-2">
              <ProgressBar value={ocrBusy.p} label={ocrBusy.label} />
            </div>
          )}
          {suggested.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-500 bg-amber-50 p-2 transition-colors dark:border-amber-600 dark:bg-amber-950">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-bold text-amber-900 dark:text-amber-300">建議遮蔽框 {suggested.length}</span>
                <span className="flex gap-1">
                  <Btn size="sm" variant="success" onClick={() => acceptSuggestions()}>
                    全部接受
                  </Btn>
                  <Btn size="sm" onClick={() => dismissSuggestions()}>
                    全部忽略
                  </Btn>
                </span>
              </div>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {suggested.map((b) => (
                  <li
                    key={b.id}
                    className={cn(
                      "flex items-center justify-between gap-1 rounded border bg-white px-1.5 py-1 text-xs transition-colors dark:bg-slate-900",
                      b.id === selectedId
                        ? "border-blue-700 dark:border-blue-500"
                        : "border-amber-300 dark:border-amber-700",
                    )}
                  >
                    <button type="button" className="min-w-0 flex-1 truncate text-left" title={b.reason} onClick={() => setSelectedId(b.id)}>
                      {b.reason}
                    </button>
                    <button type="button" className="rounded bg-emerald-700 px-1.5 font-bold text-white dark:bg-emerald-600" aria-label="接受" onClick={() => acceptSuggestions([b.id])}>
                      ✓
                    </button>
                    <button type="button" className="rounded bg-slate-300 px-1.5 font-bold text-slate-900 dark:bg-slate-700 dark:text-slate-100" aria-label="忽略" onClick={() => dismissSuggestions([b.id])}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section title="匯出">
          <div className="grid grid-cols-2 gap-1.5">
            <Btn size="sm" active={format === "png"} onClick={() => setFormat("png")}>
              PNG（無損）
            </Btn>
            <Btn size="sm" active={format === "jpeg"} onClick={() => setFormat("jpeg")}>
              JPG
            </Btn>
          </div>
          {format === "jpeg" && (
            <div className="mt-2">
              <Slider label="JPG 品質" value={quality} min={0.5} max={1} step={0.01} onChange={setQuality} />
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-slate-700 dark:text-slate-400">匯出時會重新繪製 Canvas，自動剝除 EXIF / GPS / 裝置資訊。檔名會加上 _redacted。</p>
          {pendingSuggestions > 0 && (
            <p className="mt-1 rounded bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900 transition-colors dark:bg-amber-950 dark:text-amber-300">
              尚有 {pendingSuggestions} 個建議框未確認，匯出時不會套用。
            </p>
          )}
          <div className="mt-2">
            <Switch checked={skipEmpty} onChange={setSkipEmpty} label="ZIP 略過沒有遮蔽框的圖片" />
          </div>
          <div className="mt-2 grid gap-1.5">
            <Btn variant="primary" disabled={!active || !!exporting} onClick={exportCurrent}>
              ⬇ 下載目前圖片（{ext.toUpperCase()}）
            </Btn>
            <Btn variant="success" disabled={!items.length || !!exporting} onClick={exportZip}>
              📦 全部打包下載 ZIP（{items.length}）
            </Btn>
          </div>
          {exporting && (
            <div className="mt-2">
              <ProgressBar value={exporting.p} label={exporting.label} />
            </div>
          )}
        </Section>

        <Section title="規則 Preset" className="border-b-0">
          <PresetBar presets={presets} onSave={savePreset} onApply={applyPreset} onDelete={deletePreset} keywordLabel="同時儲存 OCR 關鍵字" />
        </Section>
      </aside>
    </div>
  );
}

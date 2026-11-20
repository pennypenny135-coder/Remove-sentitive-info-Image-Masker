import { useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState, type Ref } from "react";
import { clampBox, renderBoxEffect, type Box, type Drawable, type StyleCfg } from "@/lib/imageFx";
import { uid } from "@/lib/files";

export interface CanvasHandle {
  fit(): void;
  zoomBy(f: number): void;
  actual(): void;
}

interface Props {
  itemId: string;
  source: Drawable | null;
  iw: number;
  ih: number;
  boxes: Box[];
  cfg: StyleCfg;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (boxes: Box[]) => void;
  tool: "draw" | "pan";
  onZoom?: (s: number) => void;
  ref?: Ref<CanvasHandle>;
}

type HandleName = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const CURSORS: Record<HandleName, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

type Gesture =
  | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { type: "draw"; x0: number; y0: number; id: string }
  | { type: "move"; id: string; px: number; py: number; start: Box }
  | { type: "resize"; id: string; handle: HandleName; start: Box };

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

function handlePoints(b: Box): [HandleName, number, number][] {
  const { x, y, w, h } = b;
  return [
    ["nw", x, y],
    ["n", x + w / 2, y],
    ["ne", x + w, y],
    ["e", x + w, y + h / 2],
    ["se", x + w, y + h],
    ["s", x + w / 2, y + h],
    ["sw", x, y + h],
    ["w", x, y + h / 2],
  ];
}

export function ImageCanvas(props: Props) {
  const { itemId, source, iw, ih, boxes, cfg, selectedId, onSelect, onCommit, tool, onZoom, ref } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ s: 1, ox: 0, oy: 0 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const fitted = useRef(true);
  const gesture = useRef<Gesture | null>(null);
  const spaceDown = useRef(false);
  const cache = useRef(new Map<string, HTMLCanvasElement>());
  const raf = useRef(0);
  const [rev, bump] = useReducer((x: number) => x + 1, 0);
  const [draft, setDraftState] = useState<Box[] | null>(null);
  const draftRef = useRef<Box[] | null>(null);
  const setDraft = (d: Box[] | null) => {
    draftRef.current = d;
    setDraftState(d);
  };

  const live = useRef({ props, draft });
  live.current = { props, draft };

  /* ---------------- view helpers ---------------- */
  const fit = useCallback(() => {
    const { w, h } = size.current;
    if (!w || !h) return;
    const { iw, ih } = live.current.props;
    if (!iw || !ih) return;
    const s = Math.min((w - 32) / iw, (h - 32) / ih, 2);
    view.current = { s, ox: (w - iw * s) / 2, oy: (h - ih * s) / 2 };
    fitted.current = true;
    bump();
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, f: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = cx - rect.left;
    const py = cy - rect.top;
    const v = view.current;
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * f));
    const k = ns / v.s;
    view.current = { s: ns, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
    fitted.current = false;
    bump();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomBy: (f: number) => {
        const { w, h } = size.current;
        const rect = canvasRef.current!.getBoundingClientRect();
        zoomAt(rect.left + w / 2, rect.top + h / 2, f);
      },
      actual: () => {
        const { w, h } = size.current;
        const rect = canvasRef.current!.getBoundingClientRect();
        zoomAt(rect.left + w / 2, rect.top + h / 2, 1 / view.current.s);
      },
    }),
    [fit, zoomAt],
  );

  /* ---------------- resize ---------------- */
  useEffect(() => {
    const el = containerRef.current!;
    const apply = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      size.current = { w, h, dpr };
      const cv = canvasRef.current!;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      if (fitted.current) fit();
      else bump();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // new image -> fit & drop effect cache
  useEffect(() => {
    cache.current.clear();
    setDraft(null);
    gesture.current = null;
    fit();
  }, [itemId, source, fit]);

  /* ---------------- wheel ---------------- */
  useEffect(() => {
    const cv = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* ---------------- space = pan ---------------- */
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        spaceDown.current = true;
        e.preventDefault();
        if (canvasRef.current && !gesture.current) canvasRef.current.style.cursor = "grab";
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        if (canvasRef.current) canvasRef.current.style.cursor = "";
      }
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  /* ---------------- painting ---------------- */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const { w, h, dpr } = size.current;
    if (!cv || !w) return;
    const ctx = cv.getContext("2d")!;
    const { props: p, draft: dr } = live.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!p.source) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { s, ox, oy } = view.current;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.shadowColor = "rgba(0,0,0,.5)";
    ctx.shadowBlur = 16;
    ctx.fillStyle = "#fff";
    ctx.fillRect(ox, oy, p.iw * s, p.ih * s);
    ctx.shadowBlur = 0;
    ctx.drawImage(p.source, ox, oy, p.iw * s, p.ih * s);

    const list = dr ?? p.boxes;
    const need = s * dpr;
    const rs = need >= 1 ? 1 : Math.min(1, 2 ** Math.ceil(Math.log2(need)));
    const c = p.cfg;
    const cfgKey = `${c.kind},${c.pixel},${c.blur},${c.color},${c.label},${c.autoScale}`;
    for (const b of list) {
      if (b.suggested) continue;
      const dx = ox + b.x * s;
      const dy = oy + b.y * s;
      const dw = b.w * s;
      const dh = b.h * s;
      if (dx > w || dy > h || dx + dw < 0 || dy + dh < 0) continue;
      const key = `${p.itemId}|${b.x},${b.y},${b.w},${b.h}|${cfgKey}|${rs}`;
      let fx = cache.current.get(key);
      if (!fx) {
        if (cache.current.size > 120) cache.current.clear();
        fx = renderBoxEffect(p.source, b, c, p.iw, p.ih, rs);
        cache.current.set(key, fx);
      }
      ctx.imageSmoothingEnabled = need < 1;
      ctx.drawImage(fx, dx, dy, dw, dh);
    }
    ctx.imageSmoothingEnabled = true;

    // overlays
    for (const b of list) {
      const dx = ox + b.x * s;
      const dy = oy + b.y * s;
      const dw = b.w * s;
      const dh = b.h * s;
      if (b.suggested) {
        ctx.fillStyle = "rgba(245,158,11,0.22)";
        ctx.fillRect(dx, dy, dw, dh);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#d97706";
        ctx.strokeRect(dx, dy, dw, dh);
        ctx.setLineDash([]);
      } else {
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,.9)";
        ctx.strokeRect(dx - 0.5, dy - 0.5, dw + 1, dh + 1);
        ctx.strokeStyle = "rgba(37,99,235,.95)";
        ctx.strokeRect(dx, dy, dw, dh);
      }
      if (b.id === p.selectedId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#2563eb";
        ctx.strokeRect(dx, dy, dw, dh);
        for (const [, hx, hy] of handlePoints(b)) {
          const px = ox + hx * s;
          const py = oy + hy * s;
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = "#1d4ed8";
          ctx.lineWidth = 2;
          ctx.fillRect(px - 5, py - 5, 10, 10);
          ctx.strokeRect(px - 5, py - 5, 10, 10);
        }
      }
    }
    onZoom?.(s);
  }, [onZoom]);

  useEffect(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      paint();
    });
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [rev, source, boxes, draft, cfg, selectedId, paint]);

  useEffect(
    () => () => {
      cache.current.forEach((c) => {
        c.width = 0;
        c.height = 0;
      });
      cache.current.clear();
    },
    [],
  );

  /* ---------------- pointer interaction ---------------- */
  const toImage = (cx: number, cy: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const v = view.current;
    return { x: (cx - rect.left - v.ox) / v.s, y: (cy - rect.top - v.oy) / v.s };
  };

  const hitTest = (ix: number, iy: number): { handle?: HandleName; box: Box } | null => {
    const list = live.current.draft ?? live.current.props.boxes;
    const s = view.current.s;
    const tol = 8 / s;
    const sel = list.find((b) => b.id === live.current.props.selectedId);
    if (sel) {
      for (const [name, hx, hy] of handlePoints(sel)) {
        if (Math.abs(ix - hx) <= tol && Math.abs(iy - hy) <= tol) return { handle: name, box: sel };
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (ix >= b.x && ix <= b.x + b.w && iy >= b.y && iy <= b.y + b.h) return { box: b };
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!source) return;
    const cv = canvasRef.current!;
    if (e.button === 1 || (e.button === 0 && (tool === "pan" || spaceDown.current))) {
      cv.setPointerCapture(e.pointerId);
      gesture.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: view.current.ox, oy: view.current.oy };
      fitted.current = false;
      cv.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const pt = toImage(e.clientX, e.clientY);
    const hit = hitTest(pt.x, pt.y);
    if (hit?.handle) {
      gesture.current = { type: "resize", id: hit.box.id, handle: hit.handle, start: { ...hit.box } };
    } else if (hit) {
      onSelect(hit.box.id);
      gesture.current = { type: "move", id: hit.box.id, px: pt.x, py: pt.y, start: { ...hit.box } };
    } else {
      onSelect(null);
      gesture.current = { type: "draw", x0: Math.max(0, Math.min(iw, pt.x)), y0: Math.max(0, Math.min(ih, pt.y)), id: uid() };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const cv = canvasRef.current!;
    if (!g) {
      if (spaceDown.current || tool === "pan") {
        cv.style.cursor = "grab";
        return;
      }
      const pt = toImage(e.clientX, e.clientY);
      const hit = hitTest(pt.x, pt.y);
      cv.style.cursor = hit?.handle ? CURSORS[hit.handle] : hit ? "move" : "crosshair";
      return;
    }
    if (g.type === "pan") {
      view.current = { ...view.current, ox: g.ox + e.clientX - g.sx, oy: g.oy + e.clientY - g.sy };
      bump();
      return;
    }
    const pt = toImage(e.clientX, e.clientY);
    const x = Math.max(0, Math.min(iw, pt.x));
    const y = Math.max(0, Math.min(ih, pt.y));
    if (g.type === "draw") {
      const nb: Box = { id: g.id, x: Math.min(g.x0, x), y: Math.min(g.y0, y), w: Math.abs(x - g.x0), h: Math.abs(y - g.y0) };
      setDraft([...boxes, nb]);
    } else if (g.type === "move") {
      const s0 = g.start;
      const nx = Math.max(0, Math.min(iw - s0.w, s0.x + pt.x - g.px));
      const ny = Math.max(0, Math.min(ih - s0.h, s0.y + pt.y - g.py));
      setDraft(boxes.map((b) => (b.id === g.id ? { ...b, x: nx, y: ny } : b)));
    } else if (g.type === "resize") {
      const s0 = g.start;
      let l = s0.x,
        t = s0.y,
        r = s0.x + s0.w,
        b2 = s0.y + s0.h;
      if (g.handle.includes("w")) l = x;
      if (g.handle.includes("e")) r = x;
      if (g.handle.includes("n")) t = y;
      if (g.handle.includes("s")) b2 = y;
      const nb = { x: Math.min(l, r), y: Math.min(t, b2), w: Math.abs(r - l), h: Math.abs(b2 - t) };
      setDraft(boxes.map((b) => (b.id === g.id ? { ...b, ...nb } : b)));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    const cv = canvasRef.current!;
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    cv.style.cursor = spaceDown.current || tool === "pan" ? "grab" : "";
    if (!g || g.type === "pan") return;
    const d = draftRef.current;
    setDraft(null);
    if (!d) return;
    const s = view.current.s;
    if (g.type === "draw") {
      const nb = d.find((b) => b.id === g.id);
      if (nb && nb.w * s >= 4 && nb.h * s >= 4) {
        const cb = clampBox(nb, iw, ih);
        onCommit([...boxes, cb]);
        onSelect(cb.id);
      }
      return;
    }
    const nb = d.find((b) => b.id === g.id);
    if (!nb) return;
    if (g.type === "resize" && (nb.w * s < 2 || nb.h * s < 2)) return;
    const cb = clampBox(nb, iw, ih);
    const old = boxes.find((b) => b.id === g.id);
    if (old && old.x === cb.x && old.y === cb.y && old.w === cb.w && old.h === cb.h) return;
    onCommit(boxes.map((b) => (b.id === g.id ? cb : b)));
  };

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-slate-700">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor: tool === "pan" ? "grab" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="圖片遮蔽編輯畫布"
      />
    </div>
  );
}

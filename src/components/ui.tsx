import { createContext, useCallback, useContext, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/utils/cn";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success";

const variants: Record<Variant, string> = {
  primary: "bg-blue-700 text-white hover:bg-blue-800 border-blue-800 disabled:bg-slate-300 disabled:border-slate-300 disabled:text-slate-500",
  success: "bg-emerald-700 text-white hover:bg-emerald-800 border-emerald-800 disabled:bg-slate-300 disabled:border-slate-300 disabled:text-slate-500",
  secondary: "bg-white text-slate-900 hover:bg-slate-100 border-slate-400 disabled:text-slate-400 disabled:bg-slate-50 disabled:border-slate-300",
  danger: "bg-red-700 text-white hover:bg-red-800 border-red-800 disabled:bg-slate-300 disabled:border-slate-300 disabled:text-slate-500",
  ghost: "bg-transparent text-slate-800 hover:bg-slate-200 border-transparent disabled:text-slate-400",
};

export function Btn({
  variant = "secondary",
  size = "md",
  className,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
        variants[variant],
        active && "ring-2 ring-blue-600 bg-blue-50 text-blue-900",
        className,
      )}
    />
  );
}

export function Switch({ checked, onChange, label, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; title?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 select-none" title={title}>
      <span className="relative inline-flex h-5 w-9 shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="absolute inset-0 rounded-full bg-slate-400 transition-colors peer-checked:bg-emerald-600 peer-focus-visible:outline-2 peer-focus-visible:outline-blue-600" />
        <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
      {label && <span className="text-sm text-slate-900">{label}</span>}
    </label>
  );
}

export function Section({ title, children, right, className }: { title: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={cn("border-b border-slate-300 p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold tracking-wider text-slate-600 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  unit = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-xs font-medium text-slate-800">
        <span>{label}</span>
        <span className="font-mono text-slate-900">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer accent-blue-700"
      />
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-slate-400 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-500 focus:border-blue-700 focus:outline-2 focus:outline-blue-700/40";

/* ------------------------------ toasts ------------------------------ */

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const notify = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={notify}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto rounded-md border px-3 py-2 text-sm font-medium shadow-lg",
              t.kind === "error" && "border-red-800 bg-red-700 text-white",
              t.kind === "success" && "border-emerald-800 bg-emerald-700 text-white",
              t.kind === "info" && "border-slate-900 bg-slate-900 text-white",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div>
      {label && <div className="mb-1 text-xs font-medium text-slate-800">{label}</div>}
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-300">
        <div className="h-full rounded-full bg-blue-700 transition-[width]" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
      </div>
    </div>
  );
}

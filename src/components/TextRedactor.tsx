import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Btn, ProgressBar, Section, Switch, inputCls, useToast } from "./ui";
import { PresetBar } from "./PresetBar";
import {
  CATS,
  CAT_MAP,
  createEngine,
  emptyStats,
  normalizeSettings,
  validateRegex,
  type CatId,
  type RedactMode,
  type RuleSettings,
  type Span,
  type Treat,
} from "@/lib/pii";
import {
  PREVIEW_ROWS,
  collectJsonKeys,
  csvBlob,
  defaultJsonTreats,
  defaultTableTreats,
  loadDocFromFile,
  matrixToCsvString,
  processJson,
  processTable,
  tableFields,
  textBlob,
  xlsxBlob,
  type Doc,
  type JsonResult,
  type TableCellPreview,
} from "@/lib/tabular";
import { downloadBlob, redactedName, splitName, uid } from "@/lib/files";
import { loadPrefs, loadPresets, savePrefs, savePresets, type Preset } from "@/lib/storage";
import { cn } from "@/utils/cn";

const TEXT_LIMIT = 300_000;

const SAMPLE = `【客戶服務記錄】2025-03-14 10:32
客戶陳大文（ACME Trading Ltd）致電 9123 4567，要求更新資料。
備用電話：+852 2345-6789；電郵：chan.taiman@gmail.com
身份證號碼：A123456(7)，信用卡：4111 1111 1111 1111
伺服器 log：192.168.1.100 -> 2001:db8::1 GET https://portal.example.com/user/12345?token=abc
轉帳帳號 012-345-678901-2；內地手機 13812345678。
`;

type Result =
  | { kind: "text"; src: unknown; out: string; origSpans: Span[]; outSpans: Span[]; stats: Record<CatId, number>; total: number }
  | { kind: "table"; src: unknown; rows: string[][]; preview: Map<string, TableCellPreview>; stats: Record<CatId, number>; total: number }
  | ({ kind: "json"; src: unknown; stats: Record<CatId, number>; total: number } & JsonResult);

interface TextPresetData {
  settings: RuleSettings;
}

const MODE_LABEL: Record<RedactMode, string> = { replace: "完全替換", partial: "部分掩碼", pseudo: "一致性假名化" };

function segments(text: string, spans: Span[], limit = Infinity, markCls = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  const end = Math.min(text.length, limit);
  spans.forEach((s, i) => {
    if (s.start >= end) return;
    if (s.start > pos) out.push(text.slice(pos, s.start));
    out.push(
      <mark key={i} className={markCls} title={CAT_MAP[s.cat].label} style={{ background: CAT_MAP[s.cat].color + "99", borderRadius: 3, color: "inherit", boxShadow: `0 0 0 1px ${CAT_MAP[s.cat].color}` }}>
        {text.slice(s.start, Math.min(s.end, end))}
      </mark>,
    );
    pos = Math.min(s.end, end);
  });
  if (pos < end) out.push(text.slice(pos, end));
  return out;
}

const monoCls = "m-0 border-0 p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:4]";

function HighlightedEditor({
  value,
  onChange,
  spans,
  readOnly,
  placeholder,
}: {
  value: string;
  onChange?: (v: string) => void;
  spans: Span[];
  readOnly?: boolean;
  placeholder?: string;
}) {
  const backRef = useRef<HTMLDivElement>(null);
  const big = value.length > TEXT_LIMIT;
  const nodes = useMemo(() => (big ? null : segments(value, spans)), [value, spans, big]);
  return (
    <div className="relative h-full min-h-0 bg-white">
      <div ref={backRef} aria-hidden className={cn(monoCls, "pointer-events-none absolute inset-0 overflow-x-hidden overflow-y-scroll text-transparent")}>
        {nodes}
        {"\n "}
      </div>
      <textarea
        className={cn(monoCls, "absolute inset-0 h-full w-full resize-none overflow-y-scroll bg-transparent text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-blue-600/50 focus:ring-inset")}
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        spellCheck={false}
        wrap="soft"
        onChange={(e) => onChange?.(e.target.value)}
        onScroll={(e) => {
          if (backRef.current) {
            backRef.current.scrollTop = e.currentTarget.scrollTop;
          }
        }}
        aria-label="原文"
      />
    </div>
  );
}

function HighlightedView({ text, spans }: { text: string; spans: Span[] }) {
  const truncated = text.length > TEXT_LIMIT;
  const nodes = useMemo(() => segments(text, spans, TEXT_LIMIT), [text, spans]);
  return (
    <div className="h-full overflow-auto bg-white">
      <div className={cn(monoCls, "text-slate-900")}>
        {nodes}
        {truncated && <div className="mt-2 rounded bg-amber-100 p-2 font-sans text-xs font-bold text-amber-900">預覽已截斷（只顯示前 {TEXT_LIMIT.toLocaleString()} 字元），下載／複製仍為完整內容。</div>}
      </div>
    </div>
  );
}

function TablePane({
  fields,
  rows,
  treats,
  preview,
  side,
}: {
  fields: string[];
  rows: string[][];
  treats: Treat[];
  preview?: Map<string, TableCellPreview>;
  side: "o" | "r";
}) {
  const shown = rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="h-full overflow-auto bg-white">
      <table className="min-w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-slate-200">
          <tr>
            <th className="border border-slate-300 px-2 py-1 text-right font-mono text-[11px] text-slate-600">#</th>
            {fields.map((f, c) => {
              const t = treats[c] ?? "none";
              return (
                <th key={c} className="border border-slate-300 px-2 py-1 text-left font-bold whitespace-nowrap text-slate-900">
                  {f}
                  <span className="ml-1 rounded px-1 text-[10px] font-semibold" style={{ background: t === "none" ? "#e2e8f0" : t === "detect" ? "#bfdbfe" : CAT_MAP[t].color + "aa" }}>
                    {t === "none" ? "保留" : t === "detect" ? "偵測" : CAT_MAP[t].label.split("（")[0]}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r} className="odd:bg-white even:bg-slate-50">
              <td className="border border-slate-200 px-2 py-0.5 text-right font-mono text-[11px] text-slate-500">{r + 1}</td>
              {fields.map((_, c) => {
                const cell = row[c] ?? "";
                const pv = preview?.get(`${r},${c}`);
                return (
                  <td key={c} className="max-w-[320px] border border-slate-200 px-2 py-0.5 align-top break-words whitespace-pre-wrap text-slate-900">
                    {pv ? segments(cell, side === "o" ? pv.o : pv.r) : cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PREVIEW_ROWS && <div className="p-2 text-center text-xs font-medium text-slate-700">預覽僅顯示前 {PREVIEW_ROWS} 行，共 {rows.length.toLocaleString()} 行（統計與匯出涵蓋全部資料）</div>}
      {rows.length === 0 && <div className="p-6 text-center text-sm text-slate-600">沒有資料列</div>}
    </div>
  );
}

const TREAT_WHOLE: CatId[] = ["phone", "email", "name", "address", "id", "bank", "ip", "url"];

function TreatSelect({ value, onChange }: { value: Treat; onChange: (t: Treat) => void }) {
  return (
    <select className="rounded border border-slate-400 bg-white px-1 py-0.5 text-xs text-slate-900" value={value} onChange={(e) => onChange(e.target.value as Treat)}>
      <option value="none">保留不變</option>
      <option value="detect">自動偵測（規則）</option>
      <optgroup label="整格視為…">
        {TREAT_WHOLE.map((c) => (
          <option key={c} value={c}>
            整格：{CAT_MAP[c].label}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }
}

export function TextRedactor() {
  const notify = useToast();
  const [settings, setSettings] = useState<RuleSettings>(() => normalizeSettings(loadPrefs<{ textSettings?: Partial<RuleSettings> }>({}).textSettings));
  const [doc, setDoc] = useState<Doc>({ kind: "text", name: "", text: "" });
  const [sheetIdx, setSheetIdx] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [treats, setTreats] = useState<Treat[]>([]);
  const [jsonTreats, setJsonTreats] = useState<Record<string, Treat>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [tableFmt, setTableFmt] = useState<"orig" | "csv" | "xlsx">("orig");
  const [presets, setPresets] = useState<Preset<TextPresetData>[]>(() => loadPresets<TextPresetData>("text"));
  const [dragging, setDragging] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const runRef = useRef(0);
  const dragDepth = useRef(0);

  /* preferences: rule switches only (never keywords / regex / documents) */
  useEffect(() => {
    const { keywords: _k, regexRules: _r, ...rest } = settings;
    void _k;
    void _r;
    savePrefs({ textSettings: rest });
  }, [settings]);

  /* ---------- derived table data ---------- */
  const sheet = doc.kind === "table" ? doc.sheets[Math.min(sheetIdx, doc.sheets.length - 1)] : null;
  const fields = useMemo(() => (sheet ? tableFields(sheet.matrix, hasHeader) : []), [sheet, hasHeader]);
  const dataRows = useMemo(() => (sheet ? (hasHeader ? sheet.matrix.slice(1) : sheet.matrix) : []), [sheet, hasHeader]);
  const jsonKeys = useMemo(() => (doc.kind === "json" ? collectJsonKeys(doc.value) : []), [doc]);

  /* ---------- processing ---------- */
  useEffect(() => {
    const run = ++runRef.current;
    const cancelled = () => run !== runRef.current;
    const timer = setTimeout(
      async () => {
        try {
          const engine = createEngine(settings);
          if (doc.kind === "text") {
            const r = engine.redact(doc.text);
            if (cancelled()) return;
            setResult({ kind: "text", src: doc, out: r.out, origSpans: r.origSpans, outSpans: r.outSpans, stats: { ...engine.stats }, total: engine.total() });
          } else if (doc.kind === "table") {
            setBusy(0);
            const r = await processTable(dataRows, treats, engine, cancelled, (p) => !cancelled() && setBusy(p));
            if (!r || cancelled()) return;
            setResult({ kind: "table", src: dataRows, rows: r.rows, preview: r.preview, stats: { ...engine.stats }, total: engine.total() });
          } else {
            const r = processJson(doc.value, jsonTreats, engine);
            if (cancelled()) return;
            setResult({ kind: "json", src: doc, ...r, stats: { ...engine.stats }, total: engine.total() });
          }
          setBusy(null);
        } catch (e) {
          if (!cancelled()) {
            setBusy(null);
            notify(`處理失敗：${(e as Error).message}`, "error");
          }
        }
      },
      doc.kind === "text" ? 220 : 120,
    );
    return () => clearTimeout(timer);
  }, [doc, settings, treats, jsonTreats, dataRows, notify]);

  /* ---------- loading ---------- */
  const applyDoc = useCallback((d: Doc) => {
    setResult(null);
    setSheetIdx(0);
    setHasHeader(true);
    setDoc(d);
    if (d.kind === "table") setTreats(defaultTableTreats(tableFields(d.sheets[0].matrix, true)));
    else setTreats([]);
    if (d.kind === "json") setJsonTreats(defaultJsonTreats(collectJsonKeys(d.value)));
    setTableFmt("orig");
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      setLoadingFile(true);
      await new Promise((r) => setTimeout(r, 30));
      try {
        const { doc: d, note } = await loadDocFromFile(file);
        applyDoc(d);
        notify(`已載入 ${file.name}${note ? `：${note}` : ""}`, "success");
      } catch (e) {
        notify(`讀取失敗：${(e as Error).message}`, "error");
      } finally {
        setLoadingFile(false);
      }
    },
    [applyDoc, notify],
  );

  const changeHeader = (v: boolean) => {
    setHasHeader(v);
    if (sheet) setTreats(defaultTableTreats(tableFields(sheet.matrix, v)));
  };
  const changeSheet = (i: number) => {
    if (doc.kind !== "table") return;
    setSheetIdx(i);
    setTreats(defaultTableTreats(tableFields(doc.sheets[i].matrix, hasHeader)));
  };

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
      const f = e.dataTransfer.files[0];
      if (f) void loadFile(f);
    },
  };

  /* ---------- settings helpers ---------- */
  const upd = <K extends keyof RuleSettings>(k: K, v: RuleSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const updCat = <K extends "enabled" | "mode" | "head" | "tail" | "prefix">(k: K, cat: CatId, v: RuleSettings[K][CatId]) =>
    setSettings((s) => ({ ...s, [k]: { ...s[k], [cat]: v } }));

  /* ---------- output ---------- */
  const current = result && (result.kind === "table" ? result.src === dataRows : result.src === doc) ? result : null;
  // while typing, keep showing the previous text result for ~200ms instead of flashing an empty pane
  const shownText = doc.kind === "text" && result?.kind === "text" ? result : null;

  const outputMatrix = (): string[][] | null => {
    if (!current || current.kind !== "table" || !sheet) return null;
    return hasHeader ? [sheet.matrix[0], ...current.rows] : current.rows;
  };

  const doCopy = async () => {
    if (!current) return;
    try {
      if (current.kind === "text") await copyText(current.out);
      else if (current.kind === "json") await copyText(current.outText);
      else await copyText(matrixToCsvString(outputMatrix()!, "\t"));
      notify(current.kind === "table" ? "已複製結果（Tab 分隔，可直接貼入 Excel）" : "已複製去識別化結果", "success");
    } catch {
      notify("複製失敗，請改用下載", "error");
    }
  };

  const doDownload = async () => {
    if (!current) return;
    const used = new Set<string>();
    const nm = doc.name || "text.txt";
    try {
      if (current.kind === "text") {
        downloadBlob(textBlob(current.out), redactedName(doc.name || "text", "txt", used));
      } else if (current.kind === "json") {
        downloadBlob(textBlob(current.outText, "application/json"), redactedName(nm, "json", used));
      } else if (doc.kind === "table") {
        const m = outputMatrix()!;
        const fmt = tableFmt === "orig" ? (doc.ext === "csv" ? "csv" : "xlsx") : tableFmt;
        if (fmt === "csv") downloadBlob(csvBlob(m, doc.delimiter === "\t" && splitName(nm).ext === "tsv" ? "\t" : doc.delimiter), redactedName(nm, splitName(nm).ext === "tsv" ? "tsv" : "csv", used));
        else downloadBlob(await xlsxBlob(m, sheet?.name ?? "Sheet1"), redactedName(nm, "xlsx", used));
      }
      notify("已下載去識別化檔案", "success");
    } catch (e) {
      notify(`匯出失敗：${(e as Error).message}`, "error");
    }
  };

  /* ---------- presets ---------- */
  const savePreset = (name: string, inc: boolean) => {
    const data = { ...settings, ...(inc ? {} : { keywords: "", regexRules: [] }) };
    const p: Preset<TextPresetData> = { id: uid(), name, createdAt: Date.now(), data: { settings: data } };
    const next = [...presets, p];
    setPresets(next);
    savePresets("text", next);
    notify(`已儲存 Preset「${name}」`, "success");
  };
  const applyPreset = (p: Preset<TextPresetData>) => {
    const s = normalizeSettings(p.data.settings);
    setSettings((cur) => ({ ...s, keywords: s.keywords || cur.keywords, regexRules: s.regexRules.length ? s.regexRules : cur.regexRules }));
    notify(`已套用 Preset「${p.name}」`, "success");
  };
  const deletePreset = (id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    savePresets("text", next);
  };

  /* ---------- UI ---------- */
  const stats = current?.stats ?? emptyStats();
  const total = current?.total ?? 0;
  const kindLabel = doc.kind === "text" ? "純文字" : doc.kind === "table" ? (doc.ext === "csv" ? "CSV 表格" : "Excel 表格") : "JSON";

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" {...dropHandlers}>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.xlsx,.xls,.xlsm,.json,.txt,.log,.md,text/plain,text/csv,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadFile(f);
          e.target.value = "";
        }}
      />

      {/* ------------- rules sidebar ------------- */}
      <aside className="w-full shrink-0 overflow-y-auto border-b border-slate-300 bg-white lg:w-[22rem] lg:border-r lg:border-b-0">
        <Section title="偵測規則與遮蔽模式">
          <div className="space-y-2">
            {CATS.map((c) => {
              const enabled = c.detectable ? settings.enabled[c.id] : true;
              const mode = settings.mode[c.id];
              return (
                <div key={c.id} className={cn("rounded-md border p-2", enabled ? "border-slate-400 bg-white" : "border-slate-200 bg-slate-50")}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: c.color }} />
                      {c.detectable ? (
                        <Switch checked={settings.enabled[c.id]} onChange={(v) => updCat("enabled", c.id, v)} label={<span className="font-semibold">{c.label}</span>} title={c.hint} />
                      ) : (
                        <span className="text-sm font-semibold text-slate-900" title={c.hint}>
                          {c.label}
                        </span>
                      )}
                    </div>
                    {stats[c.id] > 0 && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-bold text-white">{stats[c.id]}</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-600">{c.hint}</div>
                  {enabled && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select className="rounded border border-slate-400 bg-white px-1 py-0.5 text-xs font-medium text-slate-900" value={mode} onChange={(e) => updCat("mode", c.id, e.target.value as RedactMode)} aria-label={`${c.label} 遮蔽模式`}>
                        {(Object.keys(MODE_LABEL) as RedactMode[]).map((m) => (
                          <option key={m} value={m}>
                            {MODE_LABEL[m]}
                          </option>
                        ))}
                      </select>
                      {mode === "partial" && (
                        <span className="flex items-center gap-1 text-xs text-slate-800">
                          保留頭
                          <input type="number" min={0} max={20} className="w-12 rounded border border-slate-400 px-1 py-0.5 text-xs" value={settings.head[c.id]} onChange={(e) => updCat("head", c.id, Math.max(0, Number(e.target.value) || 0))} />
                          尾
                          <input type="number" min={0} max={20} className="w-12 rounded border border-slate-400 px-1 py-0.5 text-xs" value={settings.tail[c.id]} onChange={(e) => updCat("tail", c.id, Math.max(0, Number(e.target.value) || 0))} />
                        </span>
                      )}
                      {mode === "pseudo" && (
                        <span className="flex items-center gap-1 text-xs text-slate-800">
                          代號前綴
                          <input className="w-20 rounded border border-slate-400 px-1 py-0.5 font-mono text-xs" value={settings.prefix[c.id]} onChange={(e) => updCat("prefix", c.id, e.target.value)} />
                          <span className="font-mono text-slate-600">{settings.prefix[c.id]}001</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="完全替換文字">
          <input className={cn(inputCls, "font-mono")} value={settings.replacement} onChange={(e) => upd("replacement", e.target.value)} aria-label="替換文字" />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {["[REDACTED]", "[已遮蔽]", "[{TYPE}]", "████"].map((r) => (
              <Btn key={r} size="sm" active={settings.replacement === r} onClick={() => upd("replacement", r)}>
                {r}
              </Btn>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-700">
            <code className="rounded bg-slate-200 px-1">{"{TYPE}"}</code> 會換成類別代碼（如 PHONE、EMAIL）。
          </p>
        </Section>

        <Section title="自訂關鍵字清單">
          <textarea
            className={cn(inputCls, "h-24 resize-y font-mono")}
            placeholder={"每行一個關鍵字\n例如：陳大文\nACME Trading Ltd\nPRJ-2025-001"}
            value={settings.keywords}
            onChange={(e) => upd("keywords", e.target.value)}
            aria-label="自訂關鍵字"
          />
          <div className="mt-2 flex items-center justify-between">
            <Switch checked={settings.enabled.keyword} onChange={(v) => updCat("enabled", "keyword", v)} label="啟用關鍵字" />
            <Switch checked={settings.keywordIgnoreCase} onChange={(v) => upd("keywordIgnoreCase", v)} label="不分大小寫" />
          </div>
        </Section>

        <Section
          title="自訂 Regex 規則"
          right={
            <Btn size="sm" variant="primary" onClick={() => upd("regexRules", [...settings.regexRules, { id: uid(), name: "", pattern: "", flags: "gi", enabled: true }])}>
              ＋ 新增
            </Btn>
          }
        >
          {settings.regexRules.length === 0 && <p className="text-xs text-slate-700">例如員工編號 <code className="rounded bg-slate-200 px-1">EMP-\d{"{5}"}</code></p>}
          <div className="space-y-2">
            {settings.regexRules.map((r) => {
              const err = r.pattern ? validateRegex(r.pattern, r.flags) : null;
              const patch = (p: Partial<typeof r>) => upd("regexRules", settings.regexRules.map((x) => (x.id === r.id ? { ...x, ...p } : x)));
              return (
                <div key={r.id} className="rounded-md border border-slate-400 p-2">
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" className="accent-blue-700" checked={r.enabled} onChange={(e) => patch({ enabled: e.target.checked })} aria-label="啟用" />
                    <input className={cn(inputCls, "py-1")} placeholder="規則名稱（備註用）" value={r.name} onChange={(e) => patch({ name: e.target.value })} />
                    <button type="button" className="rounded px-1.5 font-bold text-red-700 hover:bg-red-100" aria-label="刪除規則" onClick={() => upd("regexRules", settings.regexRules.filter((x) => x.id !== r.id))}>
                      ×
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="font-mono text-slate-600">/</span>
                    <input className={cn(inputCls, "py-1 font-mono")} placeholder="pattern" value={r.pattern} onChange={(e) => patch({ pattern: e.target.value })} spellCheck={false} />
                    <span className="font-mono text-slate-600">/</span>
                    <input className={cn(inputCls, "w-14 py-1 font-mono")} value={r.flags} onChange={(e) => patch({ flags: e.target.value })} aria-label="flags" />
                  </div>
                  {err && <p className="mt-1 text-xs font-semibold text-red-700">⚠ {err}</p>}
                </div>
              );
            })}
          </div>
          {settings.regexRules.length > 0 && (
            <div className="mt-2">
              <Switch checked={settings.enabled.regex} onChange={(v) => updCat("enabled", "regex", v)} label="啟用自訂 Regex" />
              <p className="mt-1 text-[11px] text-slate-700">自訂 Regex 的遮蔽方式請見上方「自訂 Regex」類別設定。請避免巢狀量詞，以免處理大型檔案時卡住。</p>
            </div>
          )}
        </Section>

        <Section title="規則 Preset" className="border-b-0">
          <PresetBar presets={presets} onSave={savePreset} onApply={applyPreset} onDelete={deletePreset} keywordLabel="同時儲存關鍵字與自訂 Regex" />
        </Section>
      </aside>

      {/* ------------- main ------------- */}
      <main className="relative flex min-h-[560px] min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-300 bg-white px-3 py-2">
          <Btn variant="primary" size="sm" onClick={() => fileInput.current?.click()} disabled={loadingFile}>
            📂 匯入檔案（CSV / Excel / JSON / TXT）
          </Btn>
          <Btn size="sm" onClick={() => applyDoc({ kind: "text", name: "", text: "" })}>
            ✎ 貼上／輸入文字
          </Btn>
          <Btn size="sm" onClick={() => applyDoc({ kind: "text", name: "sample.txt", text: SAMPLE })}>
            載入範例
          </Btn>
          <Btn size="sm" variant="danger" disabled={doc.kind === "text" && !doc.text} onClick={() => applyDoc({ kind: "text", name: "", text: "" })}>
            清空內容
          </Btn>
          <div className="ml-auto flex items-center gap-2 text-xs text-slate-800">
            <span className="rounded bg-slate-900 px-2 py-0.5 font-bold text-white">{kindLabel}</span>
            {doc.name && <span className="max-w-48 truncate font-medium">{doc.name}</span>}
            {doc.kind === "table" && <span className="font-mono">{dataRows.length.toLocaleString()} 行 × {fields.length} 欄</span>}
            {doc.kind === "text" && doc.text && <span className="font-mono">{doc.text.length.toLocaleString()} 字元</span>}
          </div>
        </div>

        {(doc.kind === "table" || doc.kind === "json") && (
          <div className="border-b border-slate-300 bg-slate-50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="text-sm font-bold text-slate-900" onClick={() => setFieldsOpen((o) => !o)}>
                {fieldsOpen ? "▾" : "▸"} {doc.kind === "table" ? "選擇要去識別化的欄位" : "選擇要處理的 JSON 欄位（key）"}
              </button>
              {doc.kind === "table" && doc.sheets.length > 1 && (
                <select className="rounded border border-slate-400 bg-white px-1.5 py-0.5 text-xs" value={sheetIdx} onChange={(e) => changeSheet(Number(e.target.value))} aria-label="工作表">
                  {doc.sheets.map((s, i) => (
                    <option key={s.name} value={i}>
                      工作表：{s.name}
                    </option>
                  ))}
                </select>
              )}
              {doc.kind === "table" && <Switch checked={hasHeader} onChange={changeHeader} label="第一列是標題" />}
              <span className="ml-auto flex gap-1.5">
                <Btn size="sm" onClick={() => (doc.kind === "table" ? setTreats(fields.map(() => "detect")) : setJsonTreats(Object.fromEntries(jsonKeys.map((k) => [k, "detect" as Treat]))))}>
                  全部自動偵測
                </Btn>
                <Btn size="sm" onClick={() => (doc.kind === "table" ? setTreats(fields.map(() => "none")) : setJsonTreats(Object.fromEntries(jsonKeys.map((k) => [k, "none" as Treat]))))}>
                  全部保留
                </Btn>
                <Btn size="sm" variant="primary" onClick={() => (doc.kind === "table" ? setTreats(defaultTableTreats(fields)) : setJsonTreats(defaultJsonTreats(jsonKeys)))}>
                  依欄名智慧建議
                </Btn>
              </span>
            </div>
            {fieldsOpen && (
              <>
                <div className="mt-2 grid max-h-40 gap-1.5 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
                  {(doc.kind === "table" ? fields : jsonKeys).map((f, i) => {
                    const t: Treat = doc.kind === "table" ? (treats[i] ?? "none") : (jsonTreats[f] ?? "none");
                    return (
                      <div key={f + i} className={cn("flex items-center justify-between gap-2 rounded border bg-white px-2 py-1", t === "none" ? "border-slate-300" : "border-blue-600")}>
                        <span className="min-w-0 truncate text-xs font-semibold text-slate-900" title={f}>
                          {f}
                        </span>
                        <TreatSelect value={t} onChange={(v) => (doc.kind === "table" ? setTreats((cur) => cur.map((x, j) => (j === i ? v : x))) : setJsonTreats((cur) => ({ ...cur, [f]: v })))} />
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-700">
                  「整格視為」適合姓名／地址等無固定格式的欄位（整格被取代，並依該類別的遮蔽模式處理）；「自動偵測」會在儲存格內尋找電話、電郵等；「保留不變」會原樣保留業務數據。
                </p>
              </>
            )}
          </div>
        )}

        {busy !== null && busy < 1 && (
          <div className="border-b border-slate-300 bg-white px-3 py-1.5">
            <ProgressBar value={busy} label="處理中…（大型檔案會分批處理，不會卡住介面）" />
          </div>
        )}
        {loadingFile && <div className="border-b border-slate-300 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-900">解析檔案中…</div>}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-slate-400 md:grid-cols-2">
          <div className="flex min-h-[280px] min-w-0 flex-col bg-white">
            <div className="flex items-center justify-between border-b border-slate-300 bg-slate-100 px-3 py-1 text-xs font-bold text-slate-900">
              <span>原文（高光＝偵測到的敏感資料）</span>
              {current && current.total > 0 && <span className="text-red-700">⚠ {current.total} 項</span>}
            </div>
            <div className="min-h-0 flex-1">
              {doc.kind === "text" && (
                <HighlightedEditor
                  value={doc.text}
                  onChange={(v) => setDoc({ ...doc, text: v })}
                  spans={current?.kind === "text" && current.src === doc ? current.origSpans : []}
                  placeholder="在此貼上純文字、Log 或對話內容…（或拖放檔案到此頁面）"
                />
              )}
              {doc.kind === "json" && <HighlightedEditor value={current?.kind === "json" ? current.origText : ""} spans={current?.kind === "json" ? current.origSpans : []} readOnly />}
              {doc.kind === "table" && <TablePane fields={fields} rows={dataRows} treats={treats} preview={current?.kind === "table" ? current.preview : undefined} side="o" />}
            </div>
          </div>
          <div className="flex min-h-[280px] min-w-0 flex-col bg-white">
            <div className="flex items-center justify-between border-b border-slate-300 bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-950">
              <span>去識別化結果</span>
              <span className="font-normal">{current ? "即時預覽" : "處理中…"}</span>
            </div>
            <div className="min-h-0 flex-1">
              {shownText && <HighlightedView text={shownText.out} spans={shownText.outSpans} />}
              {current?.kind === "json" && <HighlightedView text={current.outText} spans={current.outSpans} />}
              {current?.kind === "table" && <TablePane fields={fields} rows={current.rows} treats={treats} preview={current.preview} side="r" />}
              {!current && !shownText && <div className="flex h-full items-center justify-center text-sm text-slate-600">{doc.kind === "text" && !doc.text ? "結果會顯示在這裡" : "處理中…"}</div>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-300 bg-white px-3 py-2">
          <span className="text-sm font-bold text-slate-900">
            共偵測／處理 <span className="rounded bg-slate-900 px-2 py-0.5 text-white">{total}</span> 項
          </span>
          {CATS.filter((c) => stats[c.id] > 0).map((c) => (
            <span key={c.id} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold text-slate-900" style={{ borderColor: c.color, background: c.color + "33" }}>
              {c.label.split("（")[0]} {stats[c.id]}
            </span>
          ))}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {doc.kind === "table" && (
              <select className="rounded border border-slate-400 bg-white px-1.5 py-1 text-xs font-medium" value={tableFmt} onChange={(e) => setTableFmt(e.target.value as typeof tableFmt)} aria-label="匯出格式">
                <option value="orig">匯出格式：原格式（{doc.ext === "csv" ? ".csv" : ".xlsx"}）</option>
                {doc.ext === "csv" ? <option value="xlsx">.xlsx</option> : <option value="csv">.csv</option>}
              </select>
            )}
            <Btn disabled={!current} onClick={doCopy}>
              📋 一鍵複製結果
            </Btn>
            <Btn variant="success" disabled={!current || (doc.kind === "text" && !doc.text)} onClick={doDownload}>
              ⬇ 下載（{doc.kind === "text" ? ".txt" : doc.kind === "json" ? ".json" : tableFmt === "orig" ? (doc.ext === "csv" ? ".csv" : ".xlsx") : `.${tableFmt}`}）
            </Btn>
          </span>
        </div>
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-4 border-dashed border-blue-500 bg-blue-900/60 text-xl font-bold text-white">放開以匯入檔案</div>
        )}
      </main>
    </div>
  );
}

/**
 * PII detection & redaction engine (pure client-side, no network).
 * Everything here is synchronous & dependency-free so it can be reused by the
 * text/table redactor and by the OCR helper in image mode.
 */

export type CatId =
  | "phone"
  | "email"
  | "id"
  | "bank"
  | "ip"
  | "url"
  | "keyword"
  | "regex"
  | "name"
  | "address";

export type RedactMode = "replace" | "partial" | "pseudo";

export interface CatInfo {
  id: CatId;
  label: string;
  code: string;
  color: string;
  /** can be auto-detected by pattern (false = only usable as whole-cell column treatment) */
  detectable: boolean;
  hint: string;
  prefix: string;
  head: number;
  tail: number;
  mode: RedactMode;
}

export const CATS: CatInfo[] = [
  { id: "phone", label: "電話號碼", code: "PHONE", color: "#f59e0b", detectable: true, hint: "香港手提／固網、+852、中國大陸、台灣、美加等", prefix: "Phone_", head: 4, tail: 0, mode: "partial" },
  { id: "email", label: "電郵地址", code: "EMAIL", color: "#3b82f6", detectable: true, hint: "name@example.com", prefix: "Email_", head: 2, tail: 0, mode: "partial" },
  { id: "id", label: "身份證／證件號碼", code: "ID", color: "#ef4444", detectable: true, hint: "香港身份證、大陸 18 位身份證、台灣身份證", prefix: "ID_", head: 4, tail: 1, mode: "partial" },
  { id: "bank", label: "信用卡／銀行帳號", code: "ACCOUNT", color: "#a855f7", detectable: true, hint: "信用卡（Luhn 驗證）、銀行帳號、IBAN", prefix: "Account_", head: 0, tail: 4, mode: "partial" },
  { id: "ip", label: "IP 位址", code: "IP", color: "#14b8a6", detectable: true, hint: "IPv4 / IPv6", prefix: "IP_", head: 3, tail: 0, mode: "replace" },
  { id: "url", label: "網址 URL", code: "URL", color: "#22c55e", detectable: true, hint: "http(s):// 、ftp://、www.", prefix: "URL_", head: 0, tail: 0, mode: "replace" },
  { id: "keyword", label: "自訂關鍵字", code: "KEYWORD", color: "#ec4899", detectable: true, hint: "公司名、人名、內部編號…", prefix: "Item_", head: 1, tail: 0, mode: "replace" },
  { id: "regex", label: "自訂 Regex", code: "CUSTOM", color: "#f97316", detectable: true, hint: "自行撰寫的正規表達式", prefix: "Data_", head: 1, tail: 1, mode: "replace" },
  { id: "name", label: "姓名（整欄）", code: "NAME", color: "#6366f1", detectable: false, hint: "僅用於表格／JSON 欄位整格處理", prefix: "User_", head: 1, tail: 0, mode: "pseudo" },
  { id: "address", label: "地址（整欄）", code: "ADDRESS", color: "#84cc16", detectable: false, hint: "僅用於表格／JSON 欄位整格處理", prefix: "Addr_", head: 3, tail: 0, mode: "replace" },
];

export const CAT_MAP = Object.fromEntries(CATS.map((c) => [c.id, c])) as Record<CatId, CatInfo>;
export const CAT_IDS = CATS.map((c) => c.id);

export interface CustomRegexRule {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  enabled: boolean;
}

export interface RuleSettings {
  enabled: Record<CatId, boolean>;
  mode: Record<CatId, RedactMode>;
  head: Record<CatId, number>;
  tail: Record<CatId, number>;
  prefix: Record<CatId, string>;
  replacement: string;
  keywords: string;
  keywordIgnoreCase: boolean;
  regexRules: CustomRegexRule[];
}

export function defaultSettings(): RuleSettings {
  const rec = <T,>(f: (c: CatInfo) => T) => Object.fromEntries(CATS.map((c) => [c.id, f(c)])) as Record<CatId, T>;
  return {
    enabled: rec((c) => c.detectable),
    mode: rec((c) => c.mode),
    head: rec((c) => c.head),
    tail: rec((c) => c.tail),
    prefix: rec((c) => c.prefix),
    replacement: "[REDACTED]",
    keywords: "",
    keywordIgnoreCase: true,
    regexRules: [],
  };
}

/** merge a (possibly partial / older) stored settings object onto defaults */
export function normalizeSettings(raw: Partial<RuleSettings> | undefined | null): RuleSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  const mergeRec = <T,>(base: Record<CatId, T>, src?: Partial<Record<CatId, T>>) => ({ ...base, ...(src || {}) });
  return {
    enabled: mergeRec(d.enabled, raw.enabled),
    mode: mergeRec(d.mode, raw.mode),
    head: mergeRec(d.head, raw.head),
    tail: mergeRec(d.tail, raw.tail),
    prefix: mergeRec(d.prefix, raw.prefix),
    replacement: typeof raw.replacement === "string" ? raw.replacement : d.replacement,
    keywords: typeof raw.keywords === "string" ? raw.keywords : "",
    keywordIgnoreCase: raw.keywordIgnoreCase ?? true,
    regexRules: Array.isArray(raw.regexRules) ? raw.regexRules : [],
  };
}

export interface Span {
  start: number;
  end: number;
  cat: CatId;
}

/* ------------------------------------------------------------------ */
/* Validators                                                          */
/* ------------------------------------------------------------------ */

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function validCard(s: string): number {
  const d = s.replace(/[ -]/g, "");
  if (d.length < 13 || d.length > 19) return 0;
  return luhn(d) ? s.length : 0;
}

function validPhone(s: string): number {
  const digits = s.replace(/\D/g, "");
  const d = digits.length;
  if (d === 8 && s.length === 8 && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(digits)) return 0; // looks like a date
  return d >= 8 && d <= 15 ? s.length : 0;
}

function validIPv6(s: string): number {
  if (s.includes(":::")) return 0;
  const parts = s.split("::");
  if (parts.length > 2) return 0;
  const hex = /^[0-9a-f]{1,4}$/i;
  const groups = (x: string) => (x ? x.split(":") : []);
  const l = groups(parts[0]);
  const r = parts.length === 2 ? groups(parts[1]) : [];
  const all = [...l, ...r];
  if (all.length === 0) return 0;
  if (!all.every((g) => hex.test(g))) return 0;
  if (parts.length === 2) return all.length <= 7 ? s.length : 0;
  return all.length === 8 ? s.length : 0;
}

function trimUrl(s: string): number {
  const m = /[.,;:!?)\]}>]+$/.exec(s);
  const len = m ? s.length - m[0].length : s.length;
  return len > 8 ? len : 0;
}

/* ------------------------------------------------------------------ */
/* Built-in detectors (ordered by priority)                             */
/* ------------------------------------------------------------------ */

interface DetectorDef {
  cat: CatId;
  source: string;
  flags: string;
  validate?: (s: string) => number;
}

const NOT_PREV = String.raw`(?<![\d\-/.@+])`;

const URL_CHARS = String.raw`[^\s<>"'\x60，。；！？）」』】]+`;

export const BUILTIN: DetectorDef[] = [
  { cat: "url", source: String.raw`(?:(?:https?|ftp|wss?):\/\/|(?<![\w@.])www\.)${URL_CHARS}`, flags: "gi", validate: trimUrl },
  { cat: "email", source: String.raw`[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)+`, flags: "gu" },
  { cat: "ip", source: String.raw`(?<![\w:.])[A-Fa-f0-9]{0,4}(?::[A-Fa-f0-9]{0,4}){2,7}(?![\w:])`, flags: "g", validate: validIPv6 },
  { cat: "ip", source: String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)`, flags: "g" },
  // Mainland China 18-digit ID
  { cat: "id", source: String.raw`(?<![\dA-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])`, flags: "g" },
  // Hong Kong ID e.g. A123456(7), AB123456(7)
  { cat: "id", source: String.raw`(?<![A-Za-z0-9])[A-Z]{1,2}\d{6}\s?\(?[0-9A]\)?(?![A-Za-z0-9])`, flags: "gi" },
  // Taiwan ID
  { cat: "id", source: String.raw`(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![A-Za-z0-9])`, flags: "g" },
  // Credit card (Luhn checked)
  { cat: "bank", source: String.raw`(?<![\d\-])(?:\d[ -]?){12,18}\d(?![\d\-])`, flags: "g", validate: validCard },
  {
    cat: "phone",
    source: [
      String.raw`(?:\+|00)\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){1,3}`,
      NOT_PREV + String.raw`1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)`,
      NOT_PREV + String.raw`09\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)`,
      NOT_PREV + String.raw`\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)`,
      NOT_PREV + String.raw`(?:852[\s-]?)?[2-9]\d{3}[\s-]?\d{4}(?!\d)`,
      NOT_PREV + String.raw`0\d{1,3}[\s-]\d{3,4}[\s-]\d{3,4}(?!\d)`,
    ].join("|"),
    flags: "g",
    validate: validPhone,
  },
  // Bank account (hyphenated HK style, long digit runs, IBAN)
  { cat: "bank", source: String.raw`(?<![\d\-])(?:\d{3}-\d{5,9}-\d{1,3}|\d{3}-\d{3}-\d{4,10})(?:-\d{1,3})?(?![\d\-])`, flags: "g" },
  { cat: "bank", source: String.raw`(?<![\d\-.])\d{10,19}(?![\d\-]|\.\d)`, flags: "g" },
  { cat: "bank", source: String.raw`(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])`, flags: "g" },
];

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseKeywords(raw: string): string[] {
  const set = new Set<string>();
  raw
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((s) => set.add(s));
  return [...set];
}

export function sanitizeFlags(flags: string): string {
  const keep = new Set<string>();
  for (const ch of flags) if ("imsu".includes(ch)) keep.add(ch);
  keep.add("g");
  return [...keep].join("");
}

export function validateRegex(pattern: string, flags: string): string | null {
  if (!pattern) return "請輸入 Regex";
  try {
    new RegExp(pattern, sanitizeFlags(flags));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/* ------------------------------------------------------------------ */
/* Masking helpers                                                     */
/* ------------------------------------------------------------------ */

const ALNUM = /[\p{L}\p{N}]/u;

function maskAlnum(value: string, head: number, tail: number): string {
  const chars = Array.from(value);
  const idx: number[] = [];
  chars.forEach((c, i) => {
    if (ALNUM.test(c)) idx.push(i);
  });
  const n = idx.length;
  if (n === 0) return value;
  const keep = new Set<number>();
  if (head + tail < n) {
    for (let i = 0; i < head; i++) keep.add(idx[i]);
    for (let i = 0; i < tail; i++) keep.add(idx[n - 1 - i]);
  }
  return chars.map((c, i) => (ALNUM.test(c) && !keep.has(i) ? "*" : c)).join("");
}

export function partialMask(value: string, cat: CatId, head: number, tail: number): string {
  head = Math.max(0, Math.floor(head || 0));
  tail = Math.max(0, Math.floor(tail || 0));
  if (cat === "email") {
    const at = value.lastIndexOf("@");
    if (at > 0) {
      const local = Array.from(value.slice(0, at));
      const domain = value.slice(at);
      const h = Math.min(head, Math.max(0, local.length - 1));
      return local.slice(0, h).join("") + "*".repeat(Math.max(3, local.length - h)) + domain;
    }
  }
  if (cat === "url") {
    const m = /^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]+)([\s\S]*)$/i.exec(value);
    if (m) return m[1] + (m[2] ? "/***" : "");
  }
  if (cat === "phone") {
    const m = /^(?:(?:\+|00)\d{1,3}[\s-]?|852[\s-]?(?=\d{4}))/.exec(value);
    if (m) return m[0] + maskAlnum(value.slice(m[0].length), head, tail);
  }
  return maskAlnum(value, head, tail);
}

function normalizeKey(cat: CatId, v: string): string {
  switch (cat) {
    case "phone":
    case "id":
    case "bank":
      return v.replace(/[\s\-()]/g, "").toUpperCase();
    default:
      return v.trim().toLowerCase();
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface RedactResult {
  out: string;
  /** spans in original coordinates */
  origSpans: Span[];
  /** spans in output coordinates */
  outSpans: Span[];
}

export interface Engine {
  detect(text: string): Span[];
  redact(text: string, whole?: CatId): RedactResult;
  stats: Record<CatId, number>;
  total(): number;
}

interface Compiled {
  cat: CatId;
  re: RegExp;
  validate?: (s: string) => number;
}

export function emptyStats(): Record<CatId, number> {
  return Object.fromEntries(CAT_IDS.map((c) => [c, 0])) as Record<CatId, number>;
}

export function createEngine(settings: RuleSettings): Engine {
  const detectors: Compiled[] = [];

  if (settings.enabled.regex) {
    for (const rule of settings.regexRules) {
      if (!rule.enabled || !rule.pattern) continue;
      try {
        detectors.push({ cat: "regex", re: new RegExp(rule.pattern, sanitizeFlags(rule.flags)) });
      } catch {
        /* invalid regex ignored (UI shows the error) */
      }
    }
  }
  if (settings.enabled.keyword) {
    const kws = parseKeywords(settings.keywords).sort((a, b) => b.length - a.length);
    if (kws.length) {
      detectors.push({
        cat: "keyword",
        re: new RegExp(kws.map(escapeRegExp).join("|"), settings.keywordIgnoreCase ? "giu" : "gu"),
      });
    }
  }
  for (const d of BUILTIN) {
    if (settings.enabled[d.cat]) detectors.push({ cat: d.cat, re: new RegExp(d.source, d.flags), validate: d.validate });
  }

  const stats = emptyStats();
  const pseudoMaps: Record<string, Map<string, string>> = {};

  function detect(text: string): Span[] {
    if (!text || detectors.length === 0) return [];
    const taken = new Uint8Array(text.length);
    const spans: Span[] = [];
    for (const det of detectors) {
      const re = det.re;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        let len = m[0].length;
        if (len === 0) {
          re.lastIndex++;
          continue;
        }
        if (det.validate) {
          len = det.validate(m[0]);
          if (!len) continue;
          re.lastIndex = m.index + len;
        }
        const start = m.index;
        const end = start + len;
        let free = true;
        for (let i = start; i < end; i++) {
          if (taken[i]) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        taken.fill(1, start, end);
        spans.push({ start, end, cat: det.cat });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  function transform(value: string, cat: CatId): string {
    stats[cat]++;
    const mode = settings.mode[cat];
    if (mode === "partial") return partialMask(value, cat, settings.head[cat], settings.tail[cat]);
    if (mode === "pseudo") {
      const map = (pseudoMaps[cat] ||= new Map());
      const key = normalizeKey(cat, value);
      let code = map.get(key);
      if (!code) {
        code = `${settings.prefix[cat] ?? ""}${String(map.size + 1).padStart(3, "0")}`;
        map.set(key, code);
      }
      return code;
    }
    return settings.replacement.split("{TYPE}").join(CAT_MAP[cat].code);
  }

  function redact(text: string, whole?: CatId): RedactResult {
    if (!text) return { out: text, origSpans: [], outSpans: [] };
    if (whole) {
      const core = text.trim();
      if (!core) return { out: text, origSpans: [], outSpans: [] };
      const lead = text.length - text.trimStart().length;
      const rep = transform(core, whole);
      const trail = text.slice(lead + core.length);
      return {
        out: text.slice(0, lead) + rep + trail,
        origSpans: [{ start: lead, end: lead + core.length, cat: whole }],
        outSpans: [{ start: lead, end: lead + rep.length, cat: whole }],
      };
    }
    const spans = detect(text);
    if (spans.length === 0) return { out: text, origSpans: [], outSpans: [] };
    let out = "";
    let pos = 0;
    const outSpans: Span[] = [];
    for (const s of spans) {
      out += text.slice(pos, s.start);
      const rep = transform(text.slice(s.start, s.end), s.cat);
      outSpans.push({ start: out.length, end: out.length + rep.length, cat: s.cat });
      out += rep;
      pos = s.end;
    }
    out += text.slice(pos);
    return { out, origSpans: spans, outSpans };
  }

  return {
    detect,
    redact,
    stats,
    total: () => CAT_IDS.reduce((a, c) => a + stats[c], 0),
  };
}

/* ------------------------------------------------------------------ */
/* Private-use markers (used to carry highlight spans through JSON)    */
/* ------------------------------------------------------------------ */

const M_START = "\uE000";
const M_END = "\uE001";
const M_CAT_BASE = 0xe100;

export function applyMarks(text: string, spans: Span[]): string {
  if (!spans.length) return text;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + M_START + String.fromCharCode(M_CAT_BASE + CAT_IDS.indexOf(s.cat)) + text.slice(s.start, s.end) + M_END;
    pos = s.end;
  }
  return out + text.slice(pos);
}

export function parseMarks(marked: string): { plain: string; spans: Span[] } {
  const spans: Span[] = [];
  const parts: string[] = [];
  const re = /[\uE000\uE001]/g;
  let len = 0;
  let last = 0;
  let open: { start: number; cat: CatId } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(marked))) {
    if (m.index > last) {
      parts.push(marked.slice(last, m.index));
      len += m.index - last;
    }
    if (m[0] === M_START) {
      const cat = CAT_IDS[marked.charCodeAt(m.index + 1) - M_CAT_BASE] ?? "regex";
      open = { start: len, cat };
      last = m.index + 2;
      re.lastIndex = last;
    } else {
      if (open) spans.push({ start: open.start, end: len, cat: open.cat });
      open = null;
      last = m.index + 1;
    }
  }
  if (last < marked.length) parts.push(marked.slice(last));
  return { plain: parts.join(""), spans };
}

/* ------------------------------------------------------------------ */
/* Header → category heuristics (for table / JSON field selection)      */
/* ------------------------------------------------------------------ */

export type Treat = "none" | "detect" | CatId;

export function suggestTreat(header: string): Treat | null {
  const h = header.trim().toLowerCase();
  if (!h) return null;
  if (/(e-?mail|電郵|郵箱|郵件|电邮|邮箱|邮件)/i.test(h)) return "email";
  if (/(phone|tel\b|telephone|mobile|cell|whatsapp|fax|電話|手機|手提|聯絡電|传真|傳真|电话|手机)/i.test(h)) return "phone";
  if (/(hkid|id\s?(no|number|card)|passport|身份證|身分證|身份证|證件|证件|護照|护照|identity)/i.test(h)) return "id";
  if (/(card|account|iban|bank|銀行|银行|帳號|帳戶|账号|账户|卡號|卡号)/i.test(h)) return "bank";
  if (/(address|addr|地址|住址|街道)/i.test(h)) return "address";
  if (/(name|姓名|名字|名稱|姓氏|聯絡人|联系人|客戶|客户|customer|contact|surname)/i.test(h)) return "name";
  if (/(\bip\b|ip_?addr)/i.test(h)) return "ip";
  if (/(url|link|網址|链接|連結)/i.test(h)) return "url";
  return null;
}

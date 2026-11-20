/**
 * localStorage is ONLY used for rule presets and tool preferences.
 * User documents / images / text are never persisted anywhere.
 */
const K_PRESETS = "pii-redactor:presets:v1";
const K_PREFS = "pii-redactor:prefs:v1";

export interface Preset<T> {
  id: string;
  name: string;
  createdAt: number;
  data: T;
}

interface PresetStore {
  text: Preset<unknown>[];
  image: Preset<unknown>[];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable / full – ignore */
  }
}

export function loadPresets<T>(kind: "text" | "image"): Preset<T>[] {
  const s = read<PresetStore>(K_PRESETS, { text: [], image: [] });
  return (Array.isArray(s[kind]) ? s[kind] : []) as Preset<T>[];
}

export function savePresets<T>(kind: "text" | "image", list: Preset<T>[]) {
  const s = read<PresetStore>(K_PRESETS, { text: [], image: [] });
  s[kind] = list as Preset<unknown>[];
  write(K_PRESETS, s);
}

export function loadPrefs<T extends object>(fallback: T): T {
  return read<T>(K_PREFS, fallback);
}

export function savePrefs(patch: Record<string, unknown>) {
  const cur = read<Record<string, unknown>>(K_PREFS, {});
  write(K_PREFS, { ...cur, ...patch });
}

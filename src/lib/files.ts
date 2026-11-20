export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, i), ext: name.slice(i + 1) };
}

/** `photo.png` -> `photo_redacted.png`, de-duplicated against `used` */
export function redactedName(name: string, ext: string, used: Set<string>): string {
  const { base } = splitName(name);
  let candidate = `${base}_redacted.${ext}`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_redacted_${n++}.${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

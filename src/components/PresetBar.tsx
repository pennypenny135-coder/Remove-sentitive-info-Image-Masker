import { useState } from "react";
import { Btn, inputCls } from "./ui";
import type { Preset } from "@/lib/storage";

interface Props<T> {
  presets: Preset<T>[];
  onSave: (name: string, includeKeywords: boolean) => void;
  onApply: (p: Preset<T>) => void;
  onDelete: (id: string) => void;
  keywordLabel?: string;
}

export function PresetBar<T>({ presets, onSave, onApply, onDelete, keywordLabel = "同時儲存自訂關鍵字清單" }: Props<T>) {
  const [name, setName] = useState("");
  const [sel, setSel] = useState("");
  const [inc, setInc] = useState(false);
  const selected = presets.find((p) => p.id === sel);
  return (
    <div className="space-y-2">
      <p className="text-xs leading-snug text-slate-700">
        Preset 只儲存「規則設定」到本機 localStorage，<b>不含任何文件／圖片內容</b>。
      </p>
      <div className="flex gap-1.5">
        <select className={inputCls} value={sel} onChange={(e) => setSel(e.target.value)} aria-label="選擇 Preset">
          <option value="">— 選擇已儲存的 Preset —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-1.5">
        <Btn size="sm" variant="primary" disabled={!selected} onClick={() => selected && onApply(selected)}>
          套用
        </Btn>
        <Btn
          size="sm"
          variant="danger"
          disabled={!selected}
          onClick={() => {
            if (selected) {
              onDelete(selected.id);
              setSel("");
            }
          }}
        >
          刪除
        </Btn>
      </div>
      <div className="flex gap-1.5">
        <input className={inputCls} placeholder="新 Preset 名稱" value={name} onChange={(e) => setName(e.target.value)} />
        <Btn
          size="sm"
          variant="success"
          disabled={!name.trim()}
          onClick={() => {
            onSave(name.trim(), inc);
            setName("");
          }}
        >
          儲存
        </Btn>
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-800">
        <input type="checkbox" className="mt-0.5 accent-blue-700" checked={inc} onChange={(e) => setInc(e.target.checked)} />
        <span>{keywordLabel}（可能含敏感字詞，預設不儲存）</span>
      </label>
    </div>
  );
}

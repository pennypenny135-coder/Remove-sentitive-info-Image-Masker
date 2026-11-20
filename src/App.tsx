import { useCallback, useEffect, useState } from "react";
import { ImageRedactor } from "@/components/ImageRedactor";
import { TextRedactor } from "@/components/TextRedactor";
import { Btn, ToastProvider, useToast } from "@/components/ui";
import { disposeOcr } from "@/lib/ocr";
import { loadPrefs, savePrefs } from "@/lib/storage";
import { cn } from "@/utils/cn";

type Tab = "image" | "text";

function Shell() {
  const notify = useToast();
  const [tab, setTab] = useState<Tab>(() => (loadPrefs<{ tab?: Tab }>({}).tab === "text" ? "text" : "image"));
  // bumping this key unmounts both workspaces => all in-memory files, previews, Blob URLs and OCR workers are released
  const [session, setSession] = useState(0);

  useEffect(() => {
    savePrefs({ tab });
  }, [tab]);

  const wipe = useCallback(() => {
    void disposeOcr();
    setSession((s) => s + 1);
    notify("已清除所有工作區資料（檔案、預覽、文字、OCR 結果皆已從記憶體移除）", "success");
  }, [notify]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900 lg:h-screen lg:overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-slate-950 px-4 py-2 text-white">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-blue-600 text-lg" aria-hidden>
            🛡
          </span>
          <div className="leading-tight">
            <h1 className="text-base font-extrabold tracking-tight">PII Redactor & Image Masker</h1>
            <p className="text-[11px] text-slate-300">敏感資料去識別化／遮蔽工具</p>
          </div>
        </div>

        <nav className="flex rounded-lg bg-slate-800 p-1" role="tablist" aria-label="工作模式">
          {(
            [
              ["image", "🖼 圖片遮蔽"],
              ["text", "📄 文字／表格去識別化"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-bold transition-colors focus-visible:outline-2 focus-visible:outline-blue-400",
                tab === id ? "bg-white text-slate-950" : "text-slate-200 hover:bg-slate-700",
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span
            className="flex items-center gap-2 rounded-full border border-emerald-400 bg-emerald-950 px-3 py-1 text-xs font-bold text-emerald-300"
            title="所有處理皆在你的瀏覽器內完成，沒有任何網絡請求會帶有你的資料"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
            🔒 100% 本地離線處理・資料絕不上傳
          </span>
          <Btn variant="danger" onClick={wipe} title="立即清空記憶體內所有檔案、預覽與文字（Preset 與偏好設定會保留）">
            🧹 清除所有工作區資料
          </Btn>
        </div>
      </header>

      <div key={session} className="flex min-h-0 flex-1 flex-col">
        <div className={cn("min-h-0 flex-1 flex-col", tab === "image" ? "flex" : "hidden")}>
          <ImageRedactor active={tab === "image"} />
        </div>
        <div className={cn("min-h-0 flex-1 flex-col", tab === "text" ? "flex" : "hidden")}>
          <TextRedactor />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

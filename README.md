# PII Redactor & Image Masker（敏感資料去識別化／遮蔽工具）

100% 純前端、本地離線處理的敏感資料遮蔽工具。所有圖片像素處理、OCR、文字／表格解析、敏感資料偵測、遮蔽、ZIP 打包與下載全部在瀏覽器內完成，**沒有後端、沒有外部 API、沒有 CDN 請求**。

## 功能

### 模式 A：圖片遮蔽（Image Redactor）
- 拖放／選取多張 PNG / JPG / WEBP；左側縮圖列切換、移除單張、清空全部。
- Canvas 手動畫框：建立、選取、移動、8 向縮放、刪除、方向鍵微調、Undo / Redo（每張圖獨立歷史）、滾輪縮放、空白鍵／中鍵／平移工具拖曳。
- 遮蔽樣式：馬賽克（可調方格，方格平均色、不可逆）、高斯模糊（可調強度，3-pass box blur，自行實作，不依賴 `ctx.filter`）、純色遮蓋（黑／白／自訂色＋文字標籤如 `REDACTED`）。「依解像度自動放大強度」可避免高解像度相片遮蔽不足。
- 「複製套用至全部圖片」：把目前圖片的框按比例複製到所有圖片（可逐張 Undo）。
- 本地 OCR（tesseract.js）：偵測電話、電郵、身份證、信用卡／帳號、IP、URL 及自訂關鍵字，產生橘色虛線「建議框」，可逐個／全部接受或忽略。語言模型、WASM core、Worker 全部打包進 App。
- 匯出：單張 PNG / JPG；全部以 jszip 打包（顯示進度）；檔名自動加 `_redacted` 並避免重名。匯出一律重繪 Canvas → **自動剝除 EXIF / GPS / 裝置 Metadata**。

### 模式 B：文字／表格去識別化
- 輸入：貼上文字；匯入 CSV / TSV / Excel（xlsx/xls，多工作表）/ JSON / TXT；自動偵測 UTF-8 / UTF-16 / Big5 / GB18030 編碼。
- 表格欄位／JSON key 逐欄設定：保留不變、自動偵測（規則）、整格視為（電話／電郵／姓名／地址／證件／帳號…）。依欄名智慧建議。
- 內置規則：香港及國際電話、電郵、香港／大陸／台灣證件號碼、信用卡（Luhn 驗證）／銀行帳號／IBAN、IPv4 / IPv6、URL；另有自訂關鍵字與自訂 Regex。
- 每類可獨立選擇：完全替換（`[REDACTED]`、`[已遮蔽]`、`[{TYPE}]`、自訂）／部分掩碼（可調保留頭尾字元，如 `9123****`、`ch***@gmail.com`）／一致性假名化（同值同代號，如 `User_001`）。
- 左右即時對照、高光所有被處理位置、各類別統計；一鍵複製；匯出 `.txt` / `.csv`（UTF-8 BOM，Excel 可正確開啟中文）/ `.xlsx` / `.json`。
- 大型 CSV 以分批（time-slice）方式處理，介面不會卡死；預覽只渲染前 100 行／30 萬字元，統計與匯出涵蓋全部資料。

## 私隱與安全設計
- 使用者的圖片、文字、表格**從不**寫入 localStorage / sessionStorage / IndexedDB。localStorage 只存「規則 Preset」與「工具偏好」（遮蔽樣式、規則開關等；偏好不含關鍵字與自訂 Regex）。
- Preset 預設只存規則；自訂關鍵字／Regex 需勾選才會一併儲存。
- 「🧹 清除所有工作區資料」：卸載兩個工作區（`key` 重掛載），釋放所有檔案、縮圖 Blob URL、解碼後的 bitmap、文字、結果，並終止 OCR Worker。
- OCR Worker 以記憶體 Blob 建立，並覆寫 worker 內 `fetch`：只允許讀取內建語言模型，其他請求一律拒絕；`cacheMethod: "none"`，不寫 IndexedDB 快取。
- 一次只在記憶體保留「目前編輯中」的一張完整解碼圖片；其餘僅保留 File 與小縮圖，匯出時逐張解碼，避免大量高解像度相片耗盡記憶體。超過瀏覽器 Canvas 上限（單邊 16384px／約 1.5 億像素）的圖片會等比縮小並提示。
- 假名化對照表只存在記憶體，不提供匯出（對照表本身即敏感資料）。

## 架構

```
src/
  App.tsx                    外殼：Tab、安全徽章、Wipe（session key）
  components/
    ImageRedactor.tsx        模式 A：縮圖列、工具列、側欄、OCR / 匯出流程
    ImageCanvas.tsx          互動畫布（縮放平移、畫框／移動／縮放、效果預覽快取）
    TextRedactor.tsx         模式 B：規則面板、欄位選擇、對照預覽、匯出
    PresetBar.tsx / ui.tsx   Preset UI、共用元件、Toast
  lib/
    pii.ts                   偵測／遮蔽引擎（regex + 驗證器、部分掩碼、假名化、標記）
    tabular.ts               CSV / Excel / JSON / TXT 載入、分批處理、匯出
    imageFx.ts               馬賽克／模糊／純色渲染、完整解析度匯出
    ocr.ts / ocrAssets.ts    本地 tesseract.js（內嵌 worker、core、eng + chi_tra）
    storage.ts / files.ts    localStorage（僅 Preset/偏好）、下載與檔名工具
```

使用套件：React 19、Vite 7、Tailwind CSS 4、`jszip`、`tesseract.js` + `tesseract.js-core` + `@tesseract.js-data/eng`、`@tesseract.js-data/chi_tra`、`papaparse`（CSV）、`xlsx`（SheetJS，Excel）、`vite-plugin-singlefile`。

## 啟動與建置

```bash
npm install
npm run dev      # 開發伺服器
npm run build    # 輸出單一檔案 dist/index.html（約 11 MB，已內嵌 OCR 模型與 WASM）
npm run preview  # 預覽 build 結果
```

`dist/index.html` 為單一自包含檔案，可部署到任何靜態空間，或離線直接開啟（OCR 的 Worker 使用 Blob URL，部分瀏覽器於 `file://` 下可能限制，建議用任何簡單的靜態伺服器，如 `npx serve dist`）。

## 已知限制
- OCR 準確度取決於圖片品質；請務必人手確認建議框。內置 OCR 核心使用 WASM SIMD 版本（現代瀏覽器皆支援）。
- 部分遮蔽以 regex 為基礎，可能有漏報／誤報；姓名、地址等無固定格式資料請使用「整格視為」或關鍵字清單。
- 高斯模糊在極小文字上理論上可能被還原，最高安全性請使用純色遮蓋或馬賽克。
- 自訂 Regex 若含災難性回溯（巢狀量詞）可能令頁面變慢。

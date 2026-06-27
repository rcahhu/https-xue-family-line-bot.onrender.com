# 2026-06-28 行程完成狀態更新

這版在「行程」瀏覽清單加入「已完成」勾選功能。

## 變更重點

- 每一筆行程在瀏覽畫面會出現「已完成」勾選。
- 勾選後會即時保存到後端 / Supabase。
- 已完成的行程會顯示綠色「已完成」標籤。
- 統計卡新增「已完成 N/總數」。
- 舊行程若沒有 completed 欄位，會自動視為未完成。

## 手機上傳提醒

這包 ZIP 的根目錄已經直接放 `src`、`public`、`package.json` 等檔案，不再多包一層 `xue-family-line-bot` 資料夾。手機解壓縮後，要把解壓後看到的檔案/資料夾上傳到 GitHub 專案根目錄覆蓋。

正確位置：

- `public/app.js`
- `public/styles.css`
- `src/storage.js`
- `src/server.js`
- `package.json`

不要變成：

- `xue-family-line-bot/public/app.js`
- `src/public/app.js`

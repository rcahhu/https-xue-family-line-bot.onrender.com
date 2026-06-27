# 2026-06-27 第二輪修正

依實測回報修正：

1. 舊日記清單會不見
   - App 開啟日記清單時會帶 `includeAll=1`，避免因 LINE LIFF / guest 身份變動導致以前建立的日記看不到。
   - 讀取到的日記會把 invite token 記在瀏覽器 localStorage，之後換入口也較不容易掉。
   - API 支援 `allowPublic=1`，App 可以讀取既有日記。
   - `OPEN_DIARY_BOOK` 預設開放；若要改回成員制，可在環境變數設 `OPEN_DIARY_BOOK=false`。
   - README 補充 Render Persistent Disk：正式使用建議 `DATA_FILE=/var/data/trips.json`。

2. 修改日記時看不到原照片、也無法刪照片
   - 行程修改表單現在會顯示已放入照片縮圖。
   - 每張照片預設勾選「保留這張」。取消勾選後儲存，就會從該行程移除。
   - 新增照片會追加在保留照片後面。

3. 瀏覽狀態看不到照片全貌
   - 行程照片縮圖改成 `object-fit: contain`，避免被裁切。
   - 點縮圖可開啟全螢幕照片檢視器，看完整照片。

4. 不要協作者 / LINE 旅伴 / 訪客旅伴
   - UI 改成「編輯者紀錄」。
   - 顯示建立者、最後編輯者，優先使用 LINE userId。
   - 移除「LINE 旅伴」、「訪客旅伴」、「協作者」、「編輯成員」等用語。

5. 打開日記本時要先看到封面照
   - 左側「我的日記」清單現在直接顯示封面照片。
   - LINE Flex 卡片有封面圖時也會顯示 hero image。

6. 日記本名稱不要印在封面上
   - App 的日記清單封面上不再疊日記名稱，名稱獨立顯示在封面下方。
   - 日記詳細頁的名稱也移到封面下方，不再壓在封面照片上。

測試：

- `node --check public/app.js`
- `node --check src/server.js`
- `node --check src/storage.js`
- `node --check src/line.js`
- 原本 smoke test 通過
- 原本 feature test 通過
- 新增測試：includeAll 清單、allowPublic 讀取、照片刪除/保留、最後編輯者 userId 紀錄通過

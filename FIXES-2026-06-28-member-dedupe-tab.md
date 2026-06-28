# 2026-06-28 同行成員去重與分頁按鈕修正

## 修正內容

- 將同行成員分頁按鈕固定為兩行顯示：
  - 同行
  - 成員
- 同行成員名單自動合併重複的人。
- 同一 LINE userId 不會重複新增成員。
- 同名的手動成員與 LINE 加入成員會合併。
- 已存在的重複成員會在讀取日記時自動整理成單一顯示。
- 合併時保留多個 LINE 身份別名，避免同名資料合併後失去原本可查看/編輯權限。
- 建立者與已加入成員重複時，合併成同一張卡片並保留建立者身分。

## 測試

- `node --check src/storage.js`
- `node --check public/app.js`
- `node --check src/server.js`
- `node --check src/line.js`
- 成員去重 smoke test：同名成員、建立者重複、手動成員升級為 LINE 成員。

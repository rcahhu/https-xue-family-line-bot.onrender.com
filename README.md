# 薛家好好玩 LINE 官方機器人

這是一個可先跑起來的 MVP：LINE Messaging API webhook + LIFF 旅行日記頁面。使用者可以建立一本旅行日記，例如「宜蘭」，再管理行程、是否購票、是否訂位、價格、附近熱門景點和旅伴許願。

## 已做好的功能

- LINE 指令：
  - `一本宜蘭` 或 `新增 宜蘭`：建立旅行日記
  - `清單`：列出旅行日記
  - `許願 想吃蔥油餅`：加入目前旅行日記的許願池
  - `推薦 宜蘭`：取得常見玩法、景點和吃法
  - `開啟`：取得目前旅行日記連結
- LIFF 頁面：
  - 建立多本旅行日記
  - 編輯行程日期、時間、地點、備註
  - 標記是否購票、是否訂位
  - 設定價格與預估總花費
  - 旅伴許願池，支援想吃、想去、想玩、其他
  - 附近熱門推薦，可一鍵加入行程
  - 用 LINE share target picker 邀請同伴；一般瀏覽器會改成分享或複製連結

## 專案結構

```text
.
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/
│  ├─ server.js
│  ├─ line.js
│  ├─ recommendations.js
│  └─ storage.js
├─ data/
├─ .env.example
└─ package.json
```

## 本機啟動

需要 Node.js 18 以上，不需要安裝額外 npm 套件。

```powershell
Copy-Item .env.example .env
npm start
```

本機頁面：

```text
http://localhost:3000/app
```

健康檢查：

```text
http://localhost:3000/health
```

## LINE 上線設定

1. 在 LINE Official Account Manager 建立官方帳號，名稱設定為 `薛家好好玩`。
2. 在 LINE Developers Console 建立 Messaging API channel，取得：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
3. 部署這個 Node.js 專案到支援 HTTPS 的平台，並設定環境變數：

```text
APP_NAME=薛家好好玩
PORT=3000
BASE_URL=https://你的網域
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
LIFF_ID=...
```

4. 在 Messaging API channel 的 Webhook URL 設定：

```text
https://你的網域/webhook
```

5. 啟用 `Use webhook`。若不想讓官方帳號自動回覆干擾 bot，建議關閉 Greeting messages 和 Auto-reply messages。
6. 建立或使用 LINE Login channel，加入 LIFF app：
   - Endpoint URL：`https://你的網域/app`
   - Scope 至少要能取得 profile
   - 開啟 share target picker
7. 將 LIFF app ID 填入 `LIFF_ID`。

LINE 官方文件：

- Messaging API bot 設定：<https://developers.line.biz/en/docs/messaging-api/building-bot/>
- LIFF app 開發：<https://developers.line.biz/en/docs/liff/developing-liff-apps/>
- share target picker：<https://developers.line.biz/en/reference/liff/#share-target-picker>

## 資料儲存

目前用 `data/trips.json` 儲存，適合 MVP 和家庭小規模使用。正式多人長期使用建議換成 SQLite、Postgres 或 Cloud Firestore。`src/storage.js` 已把資料操作集中在同一層，後續替換資料庫不需要大改 LINE 和前端邏輯。

## 之後可加強

- 接 Google Places、觀光署資料或自家後台，讓「附近熱門」變成即時搜尋。
- 用 LIFF ID token 驗證前端身份，避免使用者偽造 `userId`。
- 加上照片上傳、每日旅行日記文字、旅費分帳、票券提醒。
- 替 LINE 官方帳號建立 Rich Menu，讓「旅行日記 / 新增 / 推薦 / 許願」不用打字。

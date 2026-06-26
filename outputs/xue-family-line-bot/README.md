# 薛家好好玩 LINE 官方機器人

這是一個可先跑起來的 MVP：LINE Messaging API webhook + LIFF 旅行日記頁面。使用者可以建立一本旅行日記，例如「宜蘭」，再管理行程、是否購票、是否訂位、價格、附近熱門景點和旅伴許願。

## 已做好的功能

- LINE 指令：
  - 加入好友或輸入 `功能`：直接顯示 Flex 資料方塊，不再只用文字指令教學
  - 功能方塊包含打開日記、建立旅遊日記、順路推薦、小幫手、問旅遊助理
  - `建立日記`：AI 會先開一本新的旅行日記，並開始詢問旅行地點、日期、人數、偏好
  - 使用者可以直接聊天，例如 `第二天想去海雲台、膠囊列車，晚上吃烤肉`，AI 會自動整理成行程與待辦
  - `小幫手`：檢查缺票券、缺訂位、需查營業時間、需查交通等缺口
  - 查詢日記會以卡片列出每一本旅行日記，卡片可直接打開日記頁
  - `問 宜蘭雨天怎麼玩`：直接在 LINE 聊天室詢問旅遊助理，不需要跳到其他 AI 視窗
  - `一本 宜蘭` 或 `新增 宜蘭`：建立旅行日記
  - `查詢日記` 或 `清單`：列出旅行日記
  - `許願 想吃蔥油餅`：加入目前旅行日記的許願池
  - `推薦 宜蘭`：取得常見玩法、景點和吃法
  - `開啟`：取得目前旅行日記連結
- AI 旅遊助理：
  - 有設定 `OPENAI_API_KEY` 時，`問 ...` 和 `附近熱門` 會直接在 LINE 聊天室呼叫 OpenAI 回答
  - `OPENAI_ENABLE_WEB_SEARCH=true` 時，會使用 OpenAI 的網路搜尋工具輔助查近期資料
  - 沒設定 `OPENAI_API_KEY` 時，會明確提示尚未接上 AI，只用內建熱門資料回答
- LIFF 頁面：
  - 建立多本旅行日記
  - 建立日記使用獨立填寫頁 `/app?new=1`，不和舊日記列表共用
  - 刪除整本旅行日記
  - 日記封面可從自己的手機或電腦上傳照片
  - 手機優先版面：日記卡片列表、日記封面、快捷功能列、按日期分組的行程明細、右下角快速新增
  - 編輯行程日期、時間、地點、備註
  - 每筆行程可從自己的手機或電腦上傳照片
  - 行程支援一般行程、搭車、住宿三種資料
  - 搭車預設用「一句話」填寫，必要時再展開填交通工具、車次、哪裡到哪裡、在哪坐、時長
  - 住宿預設用「一句話」填寫，必要時再展開填住哪、地址、入住退房日期、是否含早餐、訂房編號
  - 標記是否購票、是否訂位
  - 設定價格與預估總花費
  - 每筆行程與許願都會標示建立者與最後修改者
  - 待辦清單可標示未處理、待確認、未訂票、未訂位、需查營業時間、需查交通
  - 同伴頁可看同伴人數與名單
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
│  ├─ ai.js
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
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
OPENAI_ENABLE_WEB_SEARCH=true
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

## 接上真正 AI 對話

Render 的 `Environment` 裡新增：

```text
OPENAI_API_KEY=你的 OpenAI API key
OPENAI_MODEL=gpt-5.4-mini
OPENAI_ENABLE_WEB_SEARCH=true
```

存檔後按 Render 的 `Manual Deploy` -> `Deploy latest commit`。重新部署完成後，在 LINE 裡輸入：

```text
問 宜蘭雨天怎麼玩
```

或按功能方塊的 `附近熱門`，就會在聊天室直接得到 AI 回答。OpenAI API 會依你的 OpenAI 帳號用量計費；不想用網路搜尋時，把 `OPENAI_ENABLE_WEB_SEARCH` 改成 `false`。

OpenAI 官方文件：

- Responses API：<https://platform.openai.com/docs/api-reference/responses/create>
- Web search 工具：<https://platform.openai.com/docs/guides/tools-web-search>

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

## 圖文選單建議

- 打開日記：開啟網址 `https://你的網域/app`
- 建立日記：傳送文字 `建立日記`
- 順路推薦：傳送文字 `順路推薦`
- 小幫手：傳送文字 `小幫手`
- 問旅遊助理：傳送文字 `問 `

> LINE 的圖文選單只會固定在聊天室底部；真正「邊聊邊整理」是由 webhook 收到文字後自動寫進旅行日記。

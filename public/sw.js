const CACHE_VERSION = "xue-diary-shortcut-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // 這個 service worker 主要讓手機瀏覽器可以建立桌面捷徑。
  // 實際資料仍即時向伺服器與 Supabase 讀取，避免日記內容被快取成舊資料。
  event.respondWith(fetch(event.request));
});

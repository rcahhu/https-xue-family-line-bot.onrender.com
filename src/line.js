import { getRecommendations } from "./recommendations.js";
import { makeSourceKey, normalizeActor } from "./storage.js";

export async function handleLineEvent(event, { store, config }) {
  if (event.type === "follow") {
    return replyLine(config, event.replyToken, [
      menuMessage(
        [
          `歡迎來到「${config.appName}」`,
          "",
          "你可以先用下面的快捷功能：",
          "• 建立日記：新增一本旅行日記",
          "• 查詢日記：看目前有哪些旅行日記",
          "• 開啟日記頁：進入行程、住宿、搭車和許願頁面"
        ].join("\n")
      )
    ]);
  }

  if (event.type === "join") {
    return replyLine(config, event.replyToken, [
      menuMessage("我加入群組了。可以先點「建立日記」或輸入「一本 宜蘭」。")
    ]);
  }

  if (event.type !== "message" || event.message?.type !== "text") return;

  const text = event.message.text.trim();
  const sourceKey = makeSourceKey(event.source);
  const actor = actorFromEvent(event, sourceKey);

  if (isHelp(text) || /^功能$/u.test(text)) {
    return replyLine(config, event.replyToken, [menuMessage(helpText(config.appName))]);
  }

  if (/^建立日記$/u.test(text)) {
    return replyLine(config, event.replyToken, [
      menuMessage("請直接輸入日記名稱，例如：\n\n一本 宜蘭\n新增 東京\n建立 高雄兩天一夜")
    ]);
  }

  const createMatch = text.match(/^(?:一本|新增|建立|建立日記)\s+(.+)$/u);
  if (createMatch) {
    const title = createMatch[1].trim();
    const trip = await store.createTrip({
      title,
      area: title,
      owner: actor,
      sourceKey
    });
    return replyLine(config, event.replyToken, [
      menuMessage(
        [
          `已建立「${trip.title}」旅行日記。`,
          "",
          `打開日記：${tripUrl(config, trip)}`,
          "",
          "進去後可以新增行程、搭車、住宿、許願和附近熱門景點。"
        ].join("\n")
      )
    ]);
  }

  if (/^(?:查詢日記|我的日記|日記清單|清單|日記)$/u.test(text)) {
    const trips = await store.listTrips({ userId: actor.lineUserId, sourceKey });
    const message = trips.length
      ? [
          "目前的旅行日記：",
          "",
          ...trips.slice(0, 8).map((trip, index) => `${index + 1}. ${trip.title}\n${tripUrl(config, trip)}`)
        ].join("\n")
      : "目前還沒有旅行日記。點「建立日記」，或輸入「一本 宜蘭」。";
    return replyLine(config, event.replyToken, [menuMessage(message)]);
  }

  const wishMatch = text.match(/^(?:許願|想吃|想去|想玩|願望)\s+(.+)$/u);
  if (wishMatch) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    if (!trip) {
      return replyLine(config, event.replyToken, [
        menuMessage("還沒有可以加入願望的旅行日記。請先點「建立日記」或輸入「一本 宜蘭」。")
      ]);
    }
    const wishText = wishMatch[1].trim();
    const wish = await store.addWish(trip.id, { type: guessWishType(wishText), text: wishText }, actor);
    return replyLine(config, event.replyToken, [
      menuMessage(`已把「${wish.text}」加入「${trip.title}」的許願清單。\n${tripUrl(config, trip)}`)
    ]);
  }

  const recommendMatch = text.match(/^(?:推薦|附近|附近熱門|吃什麼|玩什麼)\s*(.*)$/u);
  if (recommendMatch) {
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = recommendMatch[1].trim() || activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    return replyLine(config, event.replyToken, [menuMessage(recommendationText(recommendations))]);
  }

  if (/^(?:開啟|打開|開啟日記頁|旅遊日記|旅行日記)$/u.test(text)) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const message = trip
      ? `打開「${trip.title}」：\n${tripUrl(config, trip)}`
      : "目前還沒有旅行日記。點「建立日記」，或輸入「一本 宜蘭」。";
    return replyLine(config, event.replyToken, [menuMessage(message)]);
  }

  return replyLine(config, event.replyToken, [
    menuMessage("我先把常用功能放下面。也可以輸入「功能」再叫出這個選單。")
  ]);
}

export async function replyLine(config, replyToken, messages) {
  if (!replyToken) return;
  if (!config.lineChannelAccessToken) {
    console.log("[LINE dry-run reply]", JSON.stringify({ replyToken, messages }, null, 2));
    return;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.lineChannelAccessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${body}`);
  }
}

export function textMessage(text, quickReply = null) {
  const message = { type: "text", text: String(text).slice(0, 5000) };
  if (quickReply) message.quickReply = quickReply;
  return message;
}

export function menuMessage(text) {
  return textMessage(text, mainQuickReply());
}

export function tripUrl(config, trip) {
  const params = new URLSearchParams({
    trip: trip.id,
    invite: trip.inviteToken
  });
  if (config.liffId) return `https://liff.line.me/${config.liffId}?${params}`;
  return `${config.baseUrl.replace(/\/$/, "")}/app?${params}`;
}

function mainQuickReply() {
  return {
    items: [
      quickReplyMessage("建立日記", "建立日記"),
      quickReplyMessage("查詢日記", "查詢日記"),
      quickReplyMessage("開啟日記頁", "開啟")
    ]
  };
}

function quickReplyMessage(label, text) {
  return {
    type: "action",
    action: {
      type: "message",
      label,
      text
    }
  };
}

function actorFromEvent(event, sourceKey = makeSourceKey(event.source)) {
  return {
    ...normalizeActor({
      lineUserId: event.source?.userId || sourceKey || "line-guest",
      displayName: "LINE 旅伴"
    }),
    sourceKey
  };
}

function isHelp(text) {
  return /^(?:help|指令|說明|幫助)$/iu.test(text);
}

function helpText(appName) {
  return [
    `${appName} 常用功能`,
    "",
    "建立日記：輸入「一本 宜蘭」",
    "查詢日記：輸入「查詢日記」",
    "開啟頁面：輸入「開啟」",
    "許願：輸入「許願 想吃烤鴨」",
    "附近熱門：輸入「推薦 宜蘭」",
    "",
    "網頁裡可以新增行程、搭車、住宿、價格、同伴和每筆修改紀錄。"
  ].join("\n");
}

function guessWishType(text) {
  if (/吃|餐|飯|麵|咖啡|甜點|飲料|夜市|小吃/u.test(text)) return "food";
  if (/景點|去|玩|逛|走|公園|海|山|博物館/u.test(text)) return "spot";
  return "other";
}

function recommendationText(recommendations) {
  const spots = recommendations.spots
    .slice(0, 5)
    .map((item) => `- ${item.name}｜${item.tag}｜${item.note}`)
    .join("\n");
  const eats = recommendations.eats
    .slice(0, 5)
    .map((item) => `- ${item.name}｜${item.tag}｜${item.note}`)
    .join("\n");
  const routes = recommendations.routes.map((route) => `- ${route}`).join("\n");
  return [
    `${recommendations.areaName} 附近熱門`,
    "",
    "一般玩法：",
    routes,
    "",
    "景點：",
    spots,
    "",
    "吃的：",
    eats
  ].join("\n");
}

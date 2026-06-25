import { getRecommendations } from "./recommendations.js";
import { makeSourceKey, normalizeActor } from "./storage.js";

export async function handleLineEvent(event, { store, config }) {
  if (event.type === "follow") {
    return replyLine(config, event.replyToken, [
      textMessage(
        "薛家好好玩已加入好友。\n\n傳「一本宜蘭」或「新增 宜蘭」就能建立旅行日記；建立後可以到日記頁面編行程、購票、訂位、價格，也能邀請同伴一起許願。"
      )
    ]);
  }

  if (event.type === "join") {
    return replyLine(config, event.replyToken, [
      textMessage("薛家好好玩來了。傳「一本宜蘭」建立這個群組的旅行日記，大家就能一起許願、排景點和吃飯。")
    ]);
  }

  if (event.type !== "message" || event.message?.type !== "text") return;

  const text = event.message.text.trim();
  const sourceKey = makeSourceKey(event.source);
  const actor = actorFromEvent(event, sourceKey);

  if (isHelp(text)) {
    return replyLine(config, event.replyToken, [textMessage(helpText())]);
  }

  const createMatch = text.match(/^(?:新增|建立|開一本|一本)\s*(.+)$/u);
  if (createMatch) {
    const title = createMatch[1].trim();
    const trip = await store.createTrip({
      title,
      area: title,
      owner: actor,
      sourceKey
    });
    return replyLine(config, event.replyToken, [
      textMessage(
        `已建立「${trip.title}」旅行日記。\n\n日記頁面：${tripUrl(config, trip)}\n\n你也可以傳「許願 想吃蔥油餅」或「推薦 ${trip.area}」。`
      )
    ]);
  }

  if (/^(?:清單|日記|旅行日記|我的日記)$/u.test(text)) {
    const trips = await store.listTrips({ userId: actor.lineUserId, sourceKey });
    const message = trips.length
      ? trips
          .slice(0, 6)
          .map((trip, index) => `${index + 1}. ${trip.title}：${tripUrl(config, trip)}`)
          .join("\n")
      : "目前還沒有旅行日記。傳「一本宜蘭」就能建立第一本。";
    return replyLine(config, event.replyToken, [textMessage(message)]);
  }

  const wishMatch = text.match(/^(?:許願|想吃|想去|想玩)\s*(.+)$/u);
  if (wishMatch) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    if (!trip) {
      return replyLine(config, event.replyToken, [
        textMessage("先建立一本旅行日記吧，例如傳「一本宜蘭」，之後大家的許願就會收進同一本。")
      ]);
    }
    const wishText = text.startsWith("許願") ? wishMatch[1] : text;
    const type = guessWishType(wishText);
    const wish = await store.addWish(trip.id, { type, text: wishText }, actor);
    return replyLine(config, event.replyToken, [
      textMessage(`收到了，已把「${wish.text}」放進「${trip.title}」許願池。\n日記頁面：${tripUrl(config, trip)}`)
    ]);
  }

  const recommendMatch = text.match(/^(?:推薦|附近|熱門)\s*(.*)$/u);
  if (recommendMatch) {
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = recommendMatch[1].trim() || activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    return replyLine(config, event.replyToken, [textMessage(recommendationText(recommendations))]);
  }

  if (/^(?:開啟|打開|連結|網址)$/u.test(text)) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const message = trip
      ? `「${trip.title}」旅行日記：${tripUrl(config, trip)}`
      : "目前還沒有旅行日記。傳「一本宜蘭」就能建立第一本。";
    return replyLine(config, event.replyToken, [textMessage(message)]);
  }

  return replyLine(config, event.replyToken, [
    textMessage(
      "我看到了。你可以傳：\n\n一本宜蘭：建立旅行日記\n清單：看旅行日記\n許願 想吃烤雞：加入願望\n推薦 宜蘭：看附近玩法\n\n要編行程、購票、訂位和價格，請打開日記頁面。"
    )
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

export function textMessage(text) {
  return { type: "text", text: String(text).slice(0, 5000) };
}

export function tripUrl(config, trip) {
  const params = new URLSearchParams({
    trip: trip.id,
    invite: trip.inviteToken
  });
  if (config.liffId) return `https://liff.line.me/${config.liffId}?${params}`;
  return `${config.baseUrl.replace(/\/$/, "")}/app?${params}`;
}

function actorFromEvent(event, sourceKey = makeSourceKey(event.source)) {
  return {
    ...normalizeActor({
    lineUserId: event.source?.userId || makeSourceKey(event.source) || "line-guest",
    displayName: "LINE 旅伴"
    }),
    sourceKey
  };
}

function isHelp(text) {
  return /^(?:help|指令|說明|幫助)$/iu.test(text);
}

function helpText() {
  return [
    "薛家好好玩指令：",
    "",
    "一本宜蘭：建立旅行日記",
    "清單：查看你的旅行日記",
    "許願 想吃烤雞：加入同伴願望",
    "推薦 宜蘭：看附近玩法和吃法",
    "開啟：取得目前旅行日記連結",
    "",
    "行程、是否購票、是否訂位、價格和邀請同伴，都在日記頁面操作。"
  ].join("\n");
}

function guessWishType(text) {
  if (/吃|喝|餐|咖啡|甜點|夜市|小吃|飯|麵|冰/u.test(text)) return "food";
  if (/玩|去|景點|拍照|看海|泡湯|散步|展|山|湖/u.test(text)) return "spot";
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
    `${recommendations.areaName}附近可以這樣玩：`,
    routes,
    "",
    "熱門景點：",
    spots,
    "",
    "大家常排的吃法：",
    eats
  ].join("\n");
}

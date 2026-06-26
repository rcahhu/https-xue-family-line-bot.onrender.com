import { getRecommendations } from "./recommendations.js";
import { makeSourceKey, normalizeActor } from "./storage.js";

export async function handleLineEvent(event, { store, config }) {
  if (event.type === "follow") {
    return replyLine(config, event.replyToken, [homeFlex(config)]);
  }

  if (event.type === "join") {
    return replyLine(config, event.replyToken, [homeFlex(config, "我加入群組了，直接點下面的方塊開始。")]);
  }

  if (event.type !== "message" || event.message?.type !== "text") return;

  const text = event.message.text.trim();
  const sourceKey = makeSourceKey(event.source);
  const actor = actorFromEvent(event, sourceKey);

  if (isHome(text)) {
    return replyLine(config, event.replyToken, [homeFlex(config)]);
  }

  if (/^建立日記$/u.test(text)) {
    return replyLine(config, event.replyToken, [
      homeFlex(config, "請點「建立旅遊日記」進入全新填寫頁。")
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
    return replyLine(config, event.replyToken, [tripFlex(config, trip, "已建立旅行日記")]);
  }

  if (/^(?:查詢日記|我的日記|日記清單|清單|日記)$/u.test(text)) {
    const trips = await store.listTrips({ userId: actor.lineUserId, sourceKey });
    return replyLine(config, event.replyToken, [tripListFlex(config, trips)]);
  }

  const wishMatch = text.match(/^(?:許願|想吃|想去|想玩|願望)\s+(.+)$/u);
  if (wishMatch) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    if (!trip) {
      return replyLine(config, event.replyToken, [
        homeFlex(config, "還沒有日記可以放願望，先點「建立/查詢日記」。")
      ]);
    }
    const wishText = wishMatch[1].trim();
    const wish = await store.addWish(trip.id, { type: guessWishType(wishText), text: wishText }, actor);
    return replyLine(config, event.replyToken, [
      tripFlex(config, trip, `已加入願望：${wish.text}`)
    ]);
  }

  const recommendMatch = text.match(/^(?:推薦|附近|附近熱門|吃什麼|玩什麼)\s*(.*)$/u);
  if (recommendMatch) {
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = recommendMatch[1].trim() || activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    return replyLine(config, event.replyToken, [recommendationFlex(recommendations)]);
  }

  const assistantMatch = text.match(/^(?:問|AI|助理|智能|智慧|機器人)\s*(.*)$/iu);
  if (assistantMatch || text.endsWith("?") || text.endsWith("？")) {
    const question = (assistantMatch ? assistantMatch[1] : text).trim();
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    return replyLine(config, event.replyToken, [assistantFlex(question, activeTrip, recommendations)]);
  }

  if (/^(?:開啟|打開|開啟日記頁|旅遊日記|旅行日記)$/u.test(text)) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    return replyLine(config, event.replyToken, [
      trip ? tripFlex(config, trip, "打開目前旅行日記") : homeFlex(config, "目前還沒有日記，先建立一本。")
    ]);
  }

  return replyLine(config, event.replyToken, [homeFlex(config)]);
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

function homeUrl(config) {
  return `${config.baseUrl.replace(/\/$/, "")}/app`;
}

function newTripUrl(config) {
  return `${config.baseUrl.replace(/\/$/, "")}/app?new=1`;
}

function homeFlex(config, subtitle = "不用打關鍵字，直接點下面的方塊。") {
  return flexMessage("薛家好好玩功能選單", {
    type: "bubble",
    size: "mega",
    header: headerBlock(config.appName, "旅行日記"),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        text(subtitle, "#66746d", "sm", true),
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            actionBox("建立旅遊日記", "進入全新填寫畫面", "#52C48D", {
              type: "uri",
              label: "開啟",
              uri: newTripUrl(config)
            }),
            actionBox("查詢舊日記", "打開已建立的旅遊日記列表", "#75A9D6", {
              type: "uri",
              label: "查詢",
              uri: homeUrl(config)
            }),
            actionBox("附近熱門", "查景點、吃什麼、一般怎麼玩", "#F2B847", {
              type: "message",
              label: "推薦",
              text: "附近熱門"
            }),
            actionBox("許願", "想吃什麼、想去哪裡先放進日記", "#F26767", {
              type: "message",
              label: "許願",
              text: "許願 "
            }),
            actionBox("問旅遊助理", "直接在聊天室問，不用開別的 AI 視窗", "#7B70D8", {
              type: "message",
              label: "提問",
              text: "問 "
            })
          ]
        }
      ]
    }
  });
}

function tripListFlex(config, trips) {
  if (!trips.length) {
    return homeFlex(config, "目前還沒有旅行日記，先點「建立 / 查詢日記」新增一本。");
  }

  return flexMessage("我的旅行日記", {
    type: "carousel",
    contents: trips.slice(0, 10).map((trip) => tripBubble(config, trip, "旅行日記"))
  });
}

function tripFlex(config, trip, label = "旅行日記") {
  return flexMessage(trip.title, tripBubble(config, trip, label));
}

function tripBubble(config, trip, label) {
  return {
    type: "bubble",
    size: "mega",
    header: headerBlock(trip.title, label),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        infoRow("地區", trip.area),
        infoRow("行程", `${trip.itinerary.length} 筆`),
        infoRow("同伴", `${trip.members.length} 位`),
        infoRow("最後修改", formatDateTime(trip.updatedAt))
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        button("打開日記", {
          type: "uri",
          label: "打開日記",
          uri: tripUrl(config, trip)
        }),
        button("邀請同伴", {
          type: "uri",
          label: "邀請同伴",
          uri: tripUrl(config, trip)
        }, "secondary")
      ]
    }
  };
}

function recommendationFlex(recommendations) {
  const items = [
    ...recommendations.spots.slice(0, 3).map((item) => ({ ...item, type: "景點" })),
    ...recommendations.eats.slice(0, 3).map((item) => ({ ...item, type: "美食" }))
  ];

  return flexMessage(`${recommendations.areaName} 附近熱門`, {
    type: "bubble",
    size: "mega",
    header: headerBlock(recommendations.areaName, "附近熱門"),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        text("一般玩法", "#1f5f49", "md", true),
        ...recommendations.routes.slice(0, 3).map((route) => text(`• ${route}`, "#66746d", "sm", true)),
        separator(),
        ...items.map((item) =>
          infoRow(`${item.type}｜${item.name}`, `${item.tag}｜${item.note}`)
        )
      ]
    }
  });
}

function assistantFlex(question, trip, recommendations) {
  const area = trip?.area || recommendations.areaName || "目的地";
  const asked = question || "可以問我：雨天怎麼玩、附近吃什麼、親子景點、行程怎麼排。";
  const food = recommendations.eats.slice(0, 3).map((item) => `${item.name}：${item.note}`).join("\n");
  const spots = recommendations.spots.slice(0, 3).map((item) => `${item.name}：${item.note}`).join("\n");
  const routes = recommendations.routes.slice(0, 2).join("\n");
  const answer = buildAssistantAnswer(question, { area, food, spots, routes });

  return flexMessage("旅遊助理", {
    type: "bubble",
    size: "mega",
    header: headerBlock("旅遊助理", area),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        infoRow("你的問題", asked),
        separator(),
        text(answer, "#26332F", "sm", true)
      ]
    }
  });
}

function buildAssistantAnswer(question, { area, food, spots, routes }) {
  if (!question) {
    return `你可以直接在聊天室問我 ${area} 怎麼玩、吃什麼、雨天備案、交通怎麼排。我會先依目前日記和內建熱門資料回答。`;
  }
  if (/吃|餐|美食|小吃|咖啡|甜點|夜市/u.test(question)) {
    return `${area} 可以先看這幾個吃法：\n${food || "目前沒有美食資料，先到附近熱門查詢。"}`;
  }
  if (/玩|景點|去哪|去那|親子|雨天|備案/u.test(question)) {
    return `${area} 可以先排這些景點或玩法：\n${spots || routes || "目前沒有景點資料，先到附近熱門查詢。"}`;
  }
  if (/行程|怎麼排|安排|路線/u.test(question)) {
    return `${area} 可先照這樣排：\n${routes || "上午安排主要景點，中午排美食，下午留彈性和室內備案。"}`;
  }
  return `我先依 ${area} 的熱門資料回答：\n景點：${spots || "可先查附近熱門"}\n吃的：${food || "可先查附近熱門"}\n\n若要即時上網搜尋大數據，下一步需要接 AI 或搜尋 API 金鑰。`;
}

function flexMessage(altText, contents) {
  return {
    type: "flex",
    altText,
    contents
  };
}

function headerBlock(title, label) {
  return {
    type: "box",
    layout: "vertical",
    paddingAll: "20px",
    backgroundColor: "#52C48D",
    contents: [
      text(label, "#EFFFF6", "sm", false),
      text(title, "#FFFFFF", "xxl", true)
    ]
  };
}

function actionBox(title, subtitle, color, action) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    paddingAll: "12px",
    cornerRadius: "md",
    backgroundColor: "#F7FBF8",
    action,
    contents: [
      {
        type: "box",
        layout: "vertical",
        width: "12px",
        cornerRadius: "xxl",
        backgroundColor: color,
        contents: [{ type: "filler" }]
      },
      {
        type: "box",
        layout: "vertical",
        spacing: "xs",
        contents: [
          text(title, "#26332F", "md", true),
          text(subtitle, "#66746D", "sm", true)
        ]
      }
    ]
  };
}

function infoRow(label, value) {
  return {
    type: "box",
    layout: "vertical",
    spacing: "xs",
    contents: [
      text(label, "#7A857E", "xs", false),
      text(value || "未設定", "#26332F", "sm", true)
    ]
  };
}

function button(label, action, style = "primary") {
  return {
    type: "button",
    style,
    height: "sm",
    color: style === "primary" ? "#52C48D" : undefined,
    action: {
      ...action,
      label
    }
  };
}

function text(value, color, size, wrap) {
  return {
    type: "text",
    text: String(value || ""),
    color,
    size,
    wrap,
    weight: size === "xxl" || size === "md" ? "bold" : "regular"
  };
}

function separator() {
  return {
    type: "separator",
    margin: "md"
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

function isHome(textValue) {
  return /^(?:功能|選單|首頁|開始|help|指令|說明|幫助)$/iu.test(textValue);
}

function guessWishType(textValue) {
  if (/吃|餐|飯|麵|咖啡|甜點|飲料|夜市|小吃/u.test(textValue)) return "food";
  if (/景點|去|玩|逛|走|公園|海|山|博物館/u.test(textValue)) return "spot";
  return "other";
}

function formatDateTime(value) {
  if (!value) return "未記錄";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未記錄";
  return date.toLocaleString("zh-Hant-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

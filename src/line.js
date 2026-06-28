import { createTravelAssistantReply, createTravelPlanningUpdate } from "./ai.js";
import { DIARY_IMPORT_VERSION, parseDiaryImport } from "./diaryImport.js";
import { getRecommendations } from "./recommendations.js";
import { makeSourceKey, normalizeActor } from "./storage.js";

export async function handleLineEvent(event, { store, config }) {
  if (event.type === "follow") {
    return replyLine(config, event.replyToken, [
      homeFlex(config, "加好友成功。可以先建立一本日記，再把旅行計畫丟到聊天室，我會邊聊邊整理。")
    ]);
  }

  if (event.type === "join") {
    return replyLine(config, event.replyToken, [
      homeFlex(config, "我加入群組了。可以先建立一本日記，再把交通、住宿、想去的點丟進來。")
    ]);
  }

  if (event.type !== "message" || event.message?.type !== "text") return;

  const text = event.message.text.trim();
  const sourceKey = makeSourceKey(event.source);
  const actor = await actorFromEvent(event, sourceKey, config);

  if (/^(?:版本|version)$/iu.test(text)) {
    return replyLine(config, event.replyToken, [
      textMessage(`目前版本：${DIARY_IMPORT_VERSION}`)
    ]);
  }

  const diaryImport = parseDiaryImport(text);
  if (diaryImport) {
    const activeTrip = diaryImport.createNew
      ? null
      : await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const trip =
      activeTrip ||
      (await store.createTrip({
        ...diaryImport.trip,
        owner: actor,
        sourceKey
      }));
    const updatedTrip = await applyPlanningUpdate(store, trip, diaryImport.update, actor);
    return replyLine(config, event.replyToken, [plannerFlex(config, updatedTrip, diaryImport.update)]);
  }

  if (isHome(text)) {
    return replyLine(config, event.replyToken, [homeFlex(config)]);
  }

  if (/^(?:建立日記|建立旅遊日記|新增日記|新增旅遊日記|建立新日記)$/u.test(text)) {
    const trip = await store.createTrip({
      title: "新的旅行日記",
      area: "未設定地區",
      note: "從 LINE 建立，AI 正在收集旅行資料。",
      planning: {
        phase: "collecting_basics",
        lastQuestion: "旅行地點、日期、人數"
      },
      owner: actor,
      sourceKey
    });
    return replyLine(config, event.replyToken, [
      plannerFlex(config, trip, {
        reply: "好，我先幫你開一本新的旅行日記。\n先直接回我：旅行地點、日期、人數、喜歡的風格。\n例如：釜山 2026/8/5-8/10 4人 喜歡美食和海邊。"
      })
    ]);
  }

  const createMatch = text.match(/^(?:一本|新增|建立|建立日記)\s+(.+)$/u);
  if (createMatch) {
    const seed = createMatch[1].trim();
    const trip = await store.createTrip({
      title: "新的旅行日記",
      area: "未設定地區",
      note: "從 LINE 建立，AI 正在收集旅行資料。",
      planning: { phase: "collecting_basics" },
      owner: actor,
      sourceKey
    });
    const update = await createTravelPlanningUpdate({
      message: seed,
      trip,
      recommendations: getRecommendations({ area: seed }),
      config
    });
    const updatedTrip = await applyPlanningUpdate(store, trip, update, actor);
    return replyLine(config, event.replyToken, [plannerFlex(config, updatedTrip, update)]);
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
        textMessage("還沒有日記可以放願望。先輸入「建立日記」，我會開一本新的旅行日記。")
      ]);
    }
    const wishText = wishMatch[1].trim();
    const wish = await store.addWish(trip.id, { type: guessWishType(wishText), text: wishText }, actor);
    return replyLine(config, event.replyToken, [
      tripFlex(config, trip, `已加入願望：${wish.text}`)
    ]);
  }

  const recommendMatch = text.match(/^(?:推薦|附近|附近熱門|附近推薦|順路推薦|熱門景點|熱門美食|附近可以去哪|吃什麼|玩什麼)\s*(.*)$/u);
  if (recommendMatch) {
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = recommendMatch[1].trim() || activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    const answer = await createTravelAssistantReply({
      question: area ? `${area} 附近熱門景點、美食和一般玩法` : "附近熱門景點、美食和一般玩法",
      trip: activeTrip,
      recommendations,
      config,
      intent: "nearby"
    });
    if (activeTrip) {
      const recommendedPlaces = [
        ...(activeTrip.planning?.recommendedPlaces || []),
        ...recommendations.spots.map((item) => item.name),
        ...recommendations.eats.map((item) => item.name)
      ];
      await store.updateTrip(activeTrip.id, { planning: { recommendedPlaces } }, actor);
    }
    return replyLine(config, event.replyToken, [assistantFlex("附近熱門", activeTrip, recommendations, answer, "附近熱門")]);
  }

  const assistantMatch = text.match(/^(?:問|AI|助理|智能|智慧|機器人)\s*(.*)$/iu);
  if (assistantMatch || text.endsWith("?") || text.endsWith("？")) {
    const question = (assistantMatch ? assistantMatch[1] : text).trim();
    const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    const area = activeTrip?.area || "";
    const recommendations = getRecommendations({ area });
    const answer = await createTravelAssistantReply({
      question,
      trip: activeTrip,
      recommendations,
      config,
      intent: "ask"
    });
    return replyLine(config, event.replyToken, [assistantFlex(question, activeTrip, recommendations, answer)]);
  }

  if (/^(?:開啟|打開|開啟日記|打開日記|開啟日記頁|打開日記頁|旅遊日記|旅行日記|日記本)$/u.test(text)) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    return replyLine(config, event.replyToken, [
      trip ? tripFlex(config, trip, "打開目前旅行日記") : textMessage("目前還沒有日記。請輸入「建立日記」。")
    ]);
  }

  if (/^(?:小幫手|檢查|待辦|檢查行程)$/u.test(text)) {
    const trip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
    return replyLine(config, event.replyToken, [
      trip ? helperFlex(config, trip) : textMessage("目前還沒有日記。請輸入「建立日記」，我再幫你檢查待辦缺口。")
    ]);
  }

  const activeTrip = await store.findActiveTrip({ userId: actor.lineUserId, sourceKey });
  if (activeTrip) {
    const recommendations = getRecommendations({ area: activeTrip.planning?.currentArea || activeTrip.area });
    const update = await createTravelPlanningUpdate({
      message: text,
      trip: activeTrip,
      recommendations,
      config
    });
    const updatedTrip = await applyPlanningUpdate(store, activeTrip, update, actor);
    return replyLine(config, event.replyToken, [plannerFlex(config, updatedTrip, update)]);
  }

  if (looksLikeTravelQuestion(text)) {
    const recommendations = getRecommendations({ area: text });
    const answer = await createTravelAssistantReply({
      question: text,
      trip: null,
      recommendations,
      config,
      intent: "ask"
    });
    return replyLine(config, event.replyToken, [assistantFlex(text, null, recommendations, answer)]);
  }

  return replyLine(config, event.replyToken, [
    textMessage("我會直接把旅行內容整理成日記。請輸入「建立日記」，或直接問我旅行問題。")
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

function absoluteUrl(config, url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.baseUrl.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}

function homeUrl(config) {
  if (config.liffId) return `https://liff.line.me/${config.liffId}`;
  return `${config.baseUrl.replace(/\/$/, "")}/app`;
}

function newTripUrl(config) {
  if (config.liffId) return `https://liff.line.me/${config.liffId}?new=1`;
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
              label: "建立",
              uri: newTripUrl(config)
            }),
            actionBox("打開日記", "查看目前已整理好的旅行日記", "#75A9D6", {
              type: "uri",
              label: "打開",
              uri: homeUrl(config)
            }),
            actionBox("順路推薦", "根據目前討論區域推薦，不重複", "#F2B847", {
              type: "message",
              label: "推薦",
              text: "順路推薦"
            }),
            actionBox("小幫手", "檢查缺票券、缺訂位、交通不順", "#F26767", {
              type: "message",
              label: "檢查",
              text: "小幫手"
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
    return textMessage("目前還沒有旅行日記。請輸入「建立日記」。");
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
  const coverUrl = absoluteUrl(config, trip.coverPhotoUrl);
  return {
    type: "bubble",
    size: "mega",
    ...(coverUrl
      ? {
          hero: {
            type: "image",
            url: coverUrl,
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
          }
        }
      : {}),
    header: headerBlock(trip.title, label),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        infoRow("地區", trip.area),
        infoRow("行程", `${trip.itinerary.length} 筆`),
        infoRow("同行人數", trip.peopleCount || "未填"),
        infoRow("最後編輯", actorName(trip.updatedBy)),
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
        button("分享日記", {
          type: "uri",
          label: "分享日記",
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

function assistantFlex(question, trip, recommendations, answer, label = "旅遊助理") {
  const area = trip?.area || recommendations.areaName || "目的地";
  const asked = question || "可以問我：雨天怎麼玩、附近吃什麼、親子景點、行程怎麼排。";

  return flexMessage(label, {
    type: "bubble",
    size: "mega",
    header: headerBlock(label, area),
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

function plannerFlex(config, trip, update) {
  const addedCount = Number(update.itineraryItems?.length || 0);
  const todoCount = Number(update.todos?.length || 0);
  const wishCount = Number(update.wishes?.length || 0);
  const summary = [
    addedCount ? `行程 +${addedCount}` : "",
    todoCount ? `待辦 +${todoCount}` : "",
    wishCount ? `願望 +${wishCount}` : ""
  ]
    .filter(Boolean)
    .join("｜");

  return flexMessage("AI 已整理旅行日記", {
    type: "bubble",
    size: "mega",
    header: headerBlock("AI 旅行日記助理", trip.area || "旅行日記"),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        text(update.reply, "#26332F", "sm", true),
        summary ? text(summary, "#25845F", "sm", true) : text("你可以繼續用聊天補資料，我會邊聊邊整理。", "#66746D", "sm", true),
        separator(),
        infoRow("目前日記", trip.title),
        infoRow("待辦缺口", todoSummary(trip))
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
        button("小幫手檢查", {
          type: "message",
          label: "小幫手檢查",
          text: "小幫手"
        }, "secondary")
      ]
    }
  });
}

function helperFlex(config, trip) {
  const openTodos = (trip.todos || []).filter((todo) => !["done", "not_needed"].includes(todo.status));
  const lines = openTodos.length
    ? openTodos.slice(0, 8).map((todo) => `• ${todo.title}：${todoStatusLabel(todo.status)}`).join("\n")
    : "目前沒有明顯缺口。你可以繼續把機票、住宿、想去的點丟給我，我會幫你檢查。";

  return flexMessage("小幫手檢查", {
    type: "bubble",
    size: "mega",
    header: headerBlock("小幫手檢查", trip.title),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        text(lines, "#26332F", "sm", true),
        separator(),
        infoRow("行程數", `${trip.itinerary.length} 筆`),
        infoRow("待辦數", `${openTodos.length} 個未完成`)
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
        })
      ]
    }
  });
}

async function applyPlanningUpdate(store, trip, update, actor) {
  const patch = { ...(update.tripPatch || {}) };
  if (update.planning && Object.keys(update.planning).length) {
    patch.planning = update.planning;
  }
  let currentTrip = trip;
  if (Object.keys(patch).length) {
    currentTrip = await store.updateTrip(trip.id, patch, actor);
  }

  for (const item of update.itineraryItems || []) {
    await store.addItineraryItem(trip.id, item, actor);
  }
  for (const todo of update.todos || []) {
    await store.upsertTodoItem(trip.id, todo, actor);
  }
  for (const wish of update.wishes || []) {
    if (wish.text) await store.addWish(trip.id, wish, actor);
  }

  return store.getTrip(trip.id, { userId: actor.lineUserId, sourceKey: actor.sourceKey, allowPublic: true });
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

function actorName(actor = {}) {
  const name = String(actor.displayName || actor.name || "").trim();
  if (name && !isTechnicalIdentity(name)) return name;
  const id = String(actor.lineUserId || actor.userId || "").trim();
  if (id && !isTechnicalIdentity(id)) return id;
  return id && /^U[a-f0-9]{20,}$/i.test(id) ? "LINE 使用者" : "尚未設定名稱";
}

function isTechnicalIdentity(value) {
  const text = String(value || "").trim();
  return !text || /^guest[-_]/i.test(text) || /^guest$/i.test(text) || /^line-guest$/i.test(text) || /^U[a-f0-9]{20,}$/i.test(text);
}

async function actorFromEvent(event, sourceKey = makeSourceKey(event.source), config = {}) {
  const lineUserId = event.source?.userId || sourceKey || "line-guest";
  const displayName = await lineDisplayNameFromEvent(event, config);
  return {
    ...normalizeActor({
      lineUserId,
      displayName: displayName || lineUserId
    }),
    sourceKey
  };
}

async function lineDisplayNameFromEvent(event, config = {}) {
  const userId = event.source?.userId;
  if (!userId || !config.lineChannelAccessToken) return "";
  const source = event.source || {};
  let endpoint = `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;
  if (source.groupId) {
    endpoint = `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`;
  } else if (source.roomId) {
    endpoint = `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`;
  }
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.lineChannelAccessToken}` }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn("[LINE profile lookup failed]", response.status, body.slice(0, 200));
      return "";
    }
    const profile = await response.json();
    return String(profile.displayName || "").trim();
  } catch (error) {
    console.warn("[LINE profile lookup failed]", error?.message || error);
    return "";
  }
}

function isHome(textValue) {
  return /^(?:功能|選單|首頁|開始|help|指令|說明|幫助)$/iu.test(textValue);
}

function looksLikeTravelQuestion(textValue) {
  return /怎麼玩|下雨|雨天|吃什麼|玩什麼|去哪|景點|推薦|行程|安排|交通|住宿|餐廳|親子/u.test(textValue);
}

function todoSummary(trip) {
  const openTodos = (trip.todos || []).filter((todo) => !["done", "not_needed"].includes(todo.status));
  if (!openTodos.length) return "目前沒有未完成待辦";
  return openTodos
    .slice(0, 3)
    .map((todo) => `${todo.title}：${todoStatusLabel(todo.status)}`)
    .join("、");
}

function todoStatusLabel(status) {
  return {
    todo: "未處理",
    done: "已完成",
    not_needed: "不用處理",
    confirm: "待確認",
    need_ticket: "未訂票",
    need_reservation: "未訂位",
    need_hours: "需查營業時間",
    need_transport: "需查交通"
  }[status] || "未處理";
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

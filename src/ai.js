const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

export async function createTravelAssistantReply({
  question = "",
  trip = null,
  recommendations = null,
  config = {},
  intent = "ask"
} = {}) {
  const cleanQuestion = String(question || "").trim();
  const fallback = buildFallbackReply({
    question: cleanQuestion,
    trip,
    recommendations,
    intent,
    includeSetupNotice: !config.openaiApiKey
  });

  if (!config.openaiApiKey) return fallback;

  const payload = buildOpenAIPayload({
    question: cleanQuestion,
    trip,
    recommendations,
    config,
    intent,
    useWebSearch: config.openaiEnableWebSearch
  });

  try {
    const data = await postOpenAIResponse(payload, config);
    const answer = extractOutputText(data);
    return clampText(answer || fallback, 1400);
  } catch (error) {
    if (config.openaiEnableWebSearch && mayBeToolError(error)) {
      try {
        const data = await postOpenAIResponse(
          buildOpenAIPayload({ question: cleanQuestion, trip, recommendations, config, intent, useWebSearch: false }),
          config
        );
        const answer = extractOutputText(data);
        return clampText(answer || fallback, 1400);
      } catch (retryError) {
        console.error("[OpenAI assistant retry failed]", retryError.message);
      }
    }

    console.error("[OpenAI assistant failed]", error.message);
    return clampText(
      `AI 暫時連不上，我先用內建熱門資料回答。\n\n${buildFallbackReply({
        question: cleanQuestion,
        trip,
        recommendations,
        intent,
        includeSetupNotice: false
      })}`,
      1400
    );
  }
}

export async function createTravelPlanningUpdate({ message = "", trip = null, recommendations = null, config = {} } = {}) {
  const cleanMessage = String(message || "").trim();
  const fallback = buildHeuristicPlanningUpdate(cleanMessage, trip, recommendations);
  if (!config.openaiApiKey) return fallback;

  const payload = {
    model: config.openaiModel || DEFAULT_OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "你是 LINE 裡的 AI 旅行日記助理。你的工作不是閒聊，而是把使用者的自然語句整理成旅行日記資料。請只輸出 JSON，不要 Markdown。JSON 欄位：reply, tripPatch, itineraryItems, todos, wishes, planning。狀態只能用：todo, done, not_needed, confirm, need_ticket, need_reservation, need_hours, need_transport。行程 type 只能用 activity, transport, lodging。不要捏造使用者沒說的已訂票或已訂位。"
      },
      {
        role: "user",
        content: buildPlannerPrompt(cleanMessage, trip, recommendations)
      }
    ],
    max_output_tokens: Number(config.openaiMaxOutputTokens || 1100)
  };

  try {
    const data = await postOpenAIResponse(payload, config);
    const parsed = parseJsonFromText(extractOutputText(data));
    return normalizePlanningUpdate(parsed, fallback);
  } catch (error) {
    console.error("[OpenAI planner failed]", error.message);
    return fallback;
  }
}

function buildOpenAIPayload({ question, trip, recommendations, config, intent, useWebSearch }) {
  const input = [
    {
      role: "system",
      content:
        "你是「薛家好好玩」LINE 旅遊助理。請用繁體中文和台灣用語回答，語氣親切、實用、像在幫家人排行程。回答要適合手機聊天室閱讀，最多 8 行。不要假裝已完成訂票、訂位或查到使用者沒有提供的私人資料。營業時間、票價、交通班次等容易變動時，提醒以官方或店家資訊為準。"
    },
    {
      role: "user",
      content: buildUserPrompt({ question, trip, recommendations, intent })
    }
  ];

  const payload = {
    model: config.openaiModel || DEFAULT_OPENAI_MODEL,
    input,
    max_output_tokens: Number(config.openaiMaxOutputTokens || 900)
  };

  if (useWebSearch) {
    payload.tools = [
      {
        type: "web_search",
        search_context_size: "low",
        user_location: {
          type: "approximate",
          country: "TW"
        }
      }
    ];
  }

  return payload;
}

function buildUserPrompt({ question, trip, recommendations, intent }) {
  const area = trip?.area || recommendations?.areaQuery || recommendations?.areaName || "目的地";
  const tripSummary = trip
    ? {
        title: trip.title,
        area: trip.area,
        startDate: trip.startDate || "",
        endDate: trip.endDate || "",
        note: trip.note || "",
        members: (trip.members || []).map((member) => member.displayName).slice(0, 10),
        itinerary: (trip.itinerary || []).slice(0, 10).map((item) => ({
          type: item.type,
          title: item.title,
          date: item.date,
          time: item.time,
          place: item.place,
          transportSummary: item.transportSummary,
          lodgingSummary: item.lodgingSummary,
          price: item.price
        })),
        wishes: (trip.wishes || []).slice(0, 10).map((wish) => ({
          type: wish.type,
          text: wish.text,
          status: wish.status
        })),
        todos: (trip.todos || []).slice(0, 20).map((todo) => ({
          title: todo.title,
          category: todo.category,
          status: todo.status,
          relatedTitle: todo.relatedTitle
        })),
        planning: trip.planning || {}
      }
    : "目前沒有選定旅行日記。";

  const recommendationSummary = recommendations
    ? {
        areaName: recommendations.areaName,
        routes: recommendations.routes,
        spots: recommendations.spots?.slice(0, 8),
        eats: recommendations.eats?.slice(0, 8)
      }
    : "目前沒有內建推薦資料。";

  const ask =
    question ||
    (intent === "nearby"
      ? `請推薦 ${area} 附近熱門景點、美食和一般玩法。`
      : `請協助規劃 ${area} 旅遊。`);

  return [
    `使用者意圖：${intent === "nearby" ? "附近熱門推薦" : "自由旅遊問答"}`,
    `使用者問題：${ask}`,
    `目前目的地：${area}`,
    "",
    "目前旅行日記資料：",
    JSON.stringify(tripSummary, null, 2),
    "",
    "內建熱門資料：",
    JSON.stringify(recommendationSummary, null, 2),
    "",
    "請給可直接採用的建議。不要重複推薦已在行程、已推薦過或已拒絕的景點。若區域不明確，先反問要以哪一區為主。若你使用網路搜尋，請優先找近期、官方、店家或可信旅遊資訊；不要列太多來源網址。"
  ].join("\n");
}

function buildPlannerPrompt(message, trip, recommendations) {
  return [
    `使用者剛剛說：${message}`,
    "",
    "目前旅行日記：",
    JSON.stringify(
      trip
        ? {
            title: trip.title,
            area: trip.area,
            startDate: trip.startDate,
            endDate: trip.endDate,
            peopleCount: trip.peopleCount,
            stylePreference: trip.stylePreference,
            lodgingPreference: trip.lodgingPreference,
            planning: trip.planning,
            itinerary: (trip.itinerary || []).map((item) => ({
              type: item.type,
              title: item.title,
              day: item.day,
              date: item.date,
              time: item.time,
              area: item.area,
              place: item.place,
              ticketStatus: item.ticketStatus,
              reservationStatus: item.reservationStatus
            })),
            todos: (trip.todos || []).map((todo) => ({
              title: todo.title,
              category: todo.category,
              status: todo.status,
              relatedTitle: todo.relatedTitle
            })),
            wishes: (trip.wishes || []).map((wish) => ({
              type: wish.type,
              text: wish.text,
              status: wish.status
            }))
          }
        : null,
      null,
      2
    ),
    "",
    "內建熱門資料：",
    JSON.stringify(recommendations || null, null, 2),
    "",
    "請解析使用者是否提到地點、日期、人數、喜好、住宿偏好、已訂/未訂、想去/想吃、每日行程。把能確定的內容放進 tripPatch / itineraryItems / todos / wishes。reply 要像 LINE 回覆，告訴使用者你記了什麼，並問下一個缺的資訊。"
  ].join("\n");
}

async function postOpenAIResponse(payload, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.openaiTimeoutMs || 15000));

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await response.text();
    const data = safeJson(bodyText);
    if (!response.ok) {
      const message = data?.error?.message || bodyText || `HTTP ${response.status}`;
      throw new OpenAIRequestError(response.status, message);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      else if (typeof content.refusal === "string") parts.push(content.refusal);
    }
  }
  return parts.join("\n").trim();
}

function buildFallbackReply({ question, trip, recommendations, intent, includeSetupNotice }) {
  const area = trip?.area || recommendations?.areaName || "目的地";
  const blocked = new Set([
    ...(trip?.itinerary || []).map((item) => item.title),
    ...(trip?.planning?.recommendedPlaces || []),
    ...(trip?.planning?.rejectedPlaces || [])
  ]);
  const filterFresh = (item) => !blocked.has(item.name);
  const spots = (recommendations?.spots || [])
    .filter(filterFresh)
    .slice(0, 3)
    .map((item) => `${item.name}：${item.note}`)
    .join("\n");
  const eats = (recommendations?.eats || [])
    .filter(filterFresh)
    .slice(0, 3)
    .map((item) => `${item.name}：${item.note}`)
    .join("\n");
  const routes = (recommendations?.routes || []).slice(0, 2).join("\n");
  const notice = includeSetupNotice
    ? "目前還沒接上 AI 金鑰，所以我只能先用內建熱門資料回答。要變成真正上網查詢的大數據旅遊助理，請在 Render 加 OPENAI_API_KEY。\n\n"
    : "";

  if (intent === "nearby") {
    if (!trip?.planning?.currentArea && !trip?.area) {
      return `${notice}你想以哪一區為主？可以先回我「海雲台」、「南浦洞」或「甘川洞」這種區域，我再幫你推薦順路、不重複的景點。`;
    }
    return `${notice}${area} 先用內建熱門資料看：\n景點：\n${spots || "目前沒有景點資料"}\n\n美食：\n${eats || "目前沒有美食資料"}`;
  }

  if (!question) {
    return `${notice}你可以直接問：${area} 雨天怎麼玩、附近吃什麼、親子景點、交通怎麼排。`;
  }

  if (/吃|餐|美食|小吃|咖啡|甜點|夜市/u.test(question)) {
    return `${notice}${area} 可以先看這幾個吃法：\n${eats || "目前沒有美食資料，先到附近熱門查詢。"}`;
  }

  if (/玩|景點|去哪|去那|親子|雨天|備案/u.test(question)) {
    return `${notice}${area} 可以先排這些景點或玩法：\n${spots || routes || "目前沒有景點資料，先到附近熱門查詢。"}`;
  }

  if (/行程|怎麼排|安排|路線/u.test(question)) {
    return `${notice}${area} 可先照這樣排：\n${routes || "上午排主要景點，中午排美食，下午留彈性和室內備案。"}`;
  }

  return `${notice}我先依 ${area} 的內建熱門資料回答：\n景點：${spots || "可先查附近熱門"}\n吃的：${eats || "可先查附近熱門"}`;
}

function buildHeuristicPlanningUpdate(message, trip, recommendations) {
  const tripPatch = {};
  const planning = {};
  const itineraryItems = [];
  const todos = [];
  const wishes = [];
  const recorded = [];

  const dateRange = parseDateRange(message);
  if (dateRange.startDate) {
    tripPatch.startDate = dateRange.startDate;
    recorded.push(`日期 ${dateRange.startDate}${dateRange.endDate ? ` 到 ${dateRange.endDate}` : ""}`);
  }
  if (dateRange.endDate) tripPatch.endDate = dateRange.endDate;

  const people = message.match(/(\d+)\s*(?:人|位|大人|小孩)/u);
  if (people) {
    tripPatch.peopleCount = `${people[1]}人`;
    recorded.push(`${people[1]}人`);
  }

  const coverUrl = extractUrlAfter(message, /封面|日記封面|封面照片/u);
  if (coverUrl) {
    tripPatch.coverPhotoUrl = coverUrl;
    recorded.push("封面照片");
  }

  const area = inferArea(message, trip, recommendations);
  if (area) {
    if (!trip?.area || trip.area === "未設定地區" || /新的旅行日記|未命名/.test(trip.title || "")) {
      tripPatch.area = area;
      tripPatch.title = buildTripTitle(area, dateRange.startDate || trip?.startDate, dateRange.endDate || trip?.endDate);
    }
    planning.currentArea = area;
    planning.discussedAreas = [area];
  }

  const style = inferStyle(message);
  if (style) {
    tripPatch.stylePreference = joinUniqueText(trip?.stylePreference, style);
    recorded.push(`風格：${style}`);
  }

  const lodgingPreference = inferLodgingPreference(message);
  if (lodgingPreference) {
    tripPatch.lodgingPreference = joinUniqueText(trip?.lodgingPreference, lodgingPreference);
    recorded.push(`住宿偏好：${lodgingPreference}`);
  }

  itineraryItems.push(...extractItineraryItems(message, trip, area));
  for (const item of itineraryItems) {
    recorded.push(item.day ? `Day ${item.day} ${item.title}` : item.title);
    todos.push(...todosForItinerary(item));
  }

  todos.push(...extractStandaloneTodos(message));
  wishes.push(...extractWishes(message));

  const rejectedPlaces = extractRejectedPlaces(message);
  if (rejectedPlaces.length) {
    planning.rejectedPlaces = [...(trip?.planning?.rejectedPlaces || []), ...rejectedPlaces];
    recorded.push(`不想去：${rejectedPlaces.join("、")}`);
  }

  const missing = [];
  if (!trip?.area && !tripPatch.area) missing.push("旅行地點");
  if (!trip?.startDate && !tripPatch.startDate) missing.push("日期");
  if (!trip?.peopleCount && !tripPatch.peopleCount) missing.push("人數");
  if (!trip?.stylePreference && !tripPatch.stylePreference) missing.push("喜歡的旅行風格");

  const reply =
    recorded.length > 0
      ? `我幫你記好了：${recorded.slice(0, 6).join("、")}。\n${
          missing.length ? `下一步告訴我：${missing.slice(0, 2).join("、")}。` : "接下來可以繼續丟想去的點，我會幫你排進日記和待辦。"
        }`
      : `我在，直接跟我說旅行計畫就好，例如「第二天想去海雲台、膠囊列車，晚上吃烤肉」。我會自動整理進日記。`;

  return normalizePlanningUpdate({
    reply,
    tripPatch,
    itineraryItems,
    todos,
    wishes,
    planning
  });
}

function normalizePlanningUpdate(value = {}, fallback = {}) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    reply: String(source.reply || fallback.reply || "我已經幫你整理到旅行日記。").trim(),
    tripPatch: source.tripPatch && typeof source.tripPatch === "object" ? source.tripPatch : {},
    itineraryItems: Array.isArray(source.itineraryItems) ? source.itineraryItems : [],
    todos: Array.isArray(source.todos) ? source.todos : [],
    wishes: Array.isArray(source.wishes) ? source.wishes : [],
    planning: source.planning && typeof source.planning === "object" ? source.planning : {}
  };
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function parseDateRange(message) {
  const match = message.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\s*[–~\-到至]\s*(?:(20\d{2})[/-])?(\d{1,2})[/-](\d{1,2}))?/u);
  if (!match) return {};
  const year = match[1];
  return {
    startDate: formatDate(year, match[2], match[3]),
    endDate: match[5] ? formatDate(match[4] || year, match[5], match[6]) : ""
  };
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function inferArea(message, trip, recommendations) {
  const explicit = message.match(/(?:去|到|玩|地點|目的地|旅行|旅遊)\s*([A-Za-z\u4e00-\u9fff]{2,12})/u)?.[1];
  const known = ["釜山", "首爾", "東京", "大阪", "京都", "沖繩", "福岡", "宜蘭", "台北", "台中", "台南", "高雄", "花蓮", "海雲台", "南浦洞", "甘川洞"];
  const found = known.find((name) => message.includes(name));
  return found || explicit || trip?.planning?.currentArea || recommendations?.areaName || "";
}

function buildTripTitle(area, startDate, endDate) {
  const dateText = startDate ? ` ${startDate}${endDate ? `-${endDate}` : ""}` : "";
  return `${area}${dateText} 旅行日記`;
}

function inferStyle(message) {
  const styles = ["親子", "美食", "放鬆", "購物", "自然", "海邊", "溫泉", "拍照", "文化", "慢活", "省錢", "不趕"];
  return styles.filter((style) => message.includes(style)).join("、");
}

function inferLodgingPreference(message) {
  const prefs = ["飯店", "民宿", "含早餐", "早餐", "交通方便", "近車站", "海景", "親子房", "雙人房", "家庭房", "泳池"];
  return prefs.filter((pref) => message.includes(pref)).join("、");
}

function extractItineraryItems(message, trip, area) {
  if (!/(第.+天|day\s*\d+|上午|中午|下午|傍晚|晚上|想去|想吃|搭|住|行程)/iu.test(message)) return [];
  const day = extractDay(message);
  const items = [];
  const segments = extractTimedSegments(message);
  const chunks = segments.length
    ? [...segments, { timeLabel: "", text: stripPlanningWords(message) }]
    : [{ timeLabel: "", text: stripPlanningWords(message) }];

  for (const segment of chunks) {
    for (const raw of splitPlaces(segment.text)) {
      const title = cleanTitle(raw);
      if (!title || title.length > 32) continue;
      items.push({
        type: inferItineraryType(title, segment.text),
        title,
        day,
        time: timeLabelToTime(segment.timeLabel),
        area: area || trip?.planning?.currentArea || trip?.area || "",
        place: title,
        note: segment.timeLabel ? `${segment.timeLabel}安排` : "",
        ticketStatus: needsTicket(title) ? "needed" : "none",
        reservationStatus: needsReservation(title) ? "needed" : "none"
      });
    }
  }
  return dedupeByTitle(items).slice(0, 8);
}

function extractDay(message) {
  const match = message.match(/(?:第|day\s*)([一二三四五六七八九十\d]+)天?/iu);
  if (!match) return "";
  return String(chineseNumber(match[1]));
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [left, right] = value.split("十");
    return (map[left] || 1) * 10 + (map[right] || 0);
  }
  return map[value] || "";
}

function extractTimedSegments(message) {
  const segments = [];
  const labels = ["上午", "中午", "下午", "傍晚", "晚上"];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const nextLabels = labels.slice(index + 1).join("|");
    const regex = new RegExp(`${label}([^，。；;${nextLabels ? "" : "$"}]+?)(?=${nextLabels ? nextLabels + "|" : ""}，|。|；|;|$)`, "u");
    const match = message.match(regex);
    if (match?.[1]) segments.push({ timeLabel: label, text: match[1] });
  }
  return segments;
}

function stripPlanningWords(value) {
  return value
    .replace(/第[一二三四五六七八九十\d]+天/gu, "")
    .replace(/day\s*\d+/giu, "")
    .replace(/想去|想吃|想玩|安排|行程|可以|然後/gu, "");
}

function splitPlaces(value) {
  return stripPlanningWords(value)
    .split(/[、,，。；;和]|以及|再去|然後/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanTitle(value) {
  return value
    .replace(/^(早上|上午|中午|下午|傍晚|晚上|去|吃|住|搭|坐|看|逛)+/u, "")
    .replace(/^(在|到)/u, "")
    .trim();
}

function inferItineraryType(title, context) {
  if (/住宿|飯店|酒店|旅館|民宿|住/u.test(title + context)) return "lodging";
  if (
    /高鐵|台鐵|捷運|巴士|客運|飛機|機票|火車|計程車/u.test(title) ||
    (/^(搭|坐)/u.test(context.trim()) && !/膠囊列車/u.test(title))
  ) {
    return "transport";
  }
  return "activity";
}

function timeLabelToTime(label) {
  return { 上午: "09:00", 中午: "12:00", 下午: "14:00", 傍晚: "17:00", 晚上: "19:00" }[label] || "";
}

function needsTicket(title) {
  return /列車|門票|票|纜車|樂園|展覽|博物館|水族館|船|遊艇/u.test(title);
}

function needsReservation(title) {
  return /餐|烤肉|燒肉|咖啡|甜點|飯店|住宿|民宿|酒店|餐廳/u.test(title);
}

function todosForItinerary(item) {
  const todos = [];
  if (item.ticketStatus === "needed") {
    todos.push({ title: `${item.title} 是否訂票`, category: "ticket", status: "need_ticket", relatedTitle: item.title });
  }
  if (item.reservationStatus === "needed") {
    todos.push({ title: `${item.title} 是否訂位`, category: "reservation", status: "need_reservation", relatedTitle: item.title });
  }
  if (item.type === "activity") {
    todos.push({ title: `${item.title} 查營業時間`, category: "hours", status: "need_hours", relatedTitle: item.title });
  }
  if (item.type === "transport") {
    todos.push({ title: `${item.title} 查交通與班次`, category: "transport", status: "need_transport", relatedTitle: item.title });
  }
  return todos;
}

function extractStandaloneTodos(message) {
  const todos = [];
  const rules = [
    { keywords: ["機票"], title: "機票", category: "flight" },
    { keywords: ["住宿", "飯店", "民宿"], title: "住宿", category: "lodging" },
    { keywords: ["eSIM", "esim", "網卡"], title: "eSIM / 網卡", category: "esim" },
    { keywords: ["旅平險", "保險"], title: "旅平險", category: "insurance" }
  ];
  for (const rule of rules) {
    if (!rule.keywords.some((keyword) => message.includes(keyword))) continue;
    const status = /已訂|訂好了|完成|買了|已買|處理好/u.test(message)
      ? "done"
      : /不用|不需要/u.test(message)
        ? "not_needed"
        : /未|還沒|沒訂|待確認/u.test(message)
          ? "confirm"
          : "todo";
    todos.push({ title: rule.title, category: rule.category, status });
  }
  return todos;
}

function extractWishes(message) {
  if (/(第.+天|day\s*\d+|上午|中午|下午|傍晚|晚上|行程)/iu.test(message)) return [];
  const match = message.match(/(?:想吃|想去|想玩|許願)\s*([^。]+)/u);
  if (!match) return [];
  const text = match[1].trim();
  if (!text) return [];
  return [{ type: /吃/u.test(match[0]) ? "food" : /去/u.test(match[0]) ? "spot" : "activity", text }];
}

function extractRejectedPlaces(message) {
  if (!/不想去|不要|先不要|排除/u.test(message)) return [];
  return splitPlaces(message.replace(/不想去|不要|先不要|排除/gu, "")).slice(0, 8);
}

function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinUniqueText(existing, added) {
  return Array.from(new Set([...(existing || "").split("、"), ...(added || "").split("、")].map((item) => item.trim()).filter(Boolean))).join("、");
}

function extractUrlAfter(message, markerPattern) {
  if (!markerPattern.test(message)) return "";
  return message.match(/https?:\/\/\S+/i)?.[0] || "";
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mayBeToolError(error) {
  return error instanceof OpenAIRequestError && /tool|web_search|unsupported|invalid/i.test(error.message);
}

function clampText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

class OpenAIRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
  }
}

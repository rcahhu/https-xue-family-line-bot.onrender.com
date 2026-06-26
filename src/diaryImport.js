const DATE_RANGE_RE =
  /(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\s*[~–—-]\s*(?:(20\d{2})[/-])?(\d{1,2})[/-](\d{1,2})/u;

const SECTION_TITLES = new Set(["行程總覽", "待檢查清單", "日記文字版"]);
const TODO_STATUSES = ["已確認", "已訂購", "已訂位", "已完成", "待補", "待確認", "未確認", "未處理", "不用處理"];

export const DIARY_IMPORT_VERSION = "2026-06-26-natural-text-v2";

export function parseDiaryImport(message = "") {
  const raw = normalizeText(message);
  if (!looksLikeDiaryImport(raw)) return null;

  const titleLine = findTitleLine(raw);
  const dateRange = parseDateRange(titleLine || raw);
  const title = buildTitle(titleLine, dateRange);
  const area = inferArea(titleLine || raw);
  const diaryNote = extractSection(raw, "日記文字版");
  const itineraryItems = parseItineraryItems(raw, dateRange.startDate);
  const todos = parseTodoTable(raw);
  const peopleCount = inferPeopleCount(raw);

  return {
    createNew: /^生成日記本(?:\s|$)/u.test(raw) || /^#\s+/m.test(raw),
    trip: {
      title,
      area,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      note: diaryNote || "由 LINE 貼上的行程整理自動生成。",
      peopleCount,
      planning: {
        phase: "imported_diary",
        currentArea: area,
        discussedAreas: area ? splitArea(area) : []
      }
    },
    update: {
      reply: [
        "已幫你生成日記本。",
        `日記：${title}`,
        itineraryItems.length ? `已整理 ${itineraryItems.length} 筆交通/行程。` : "",
        todos.length ? `已放入 ${todos.length} 筆待檢查清單。` : "",
        "你可以打開日記本檢查，之後再補照片、住宿、餐廳或心得。"
      ]
        .filter(Boolean)
        .join("\n"),
      tripPatch: {
        title,
        area,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        note: diaryNote || "由 LINE 貼上的行程整理自動生成。",
        peopleCount
      },
      itineraryItems,
      todos,
      wishes: [],
      planning: {
        phase: "imported_diary",
        currentArea: area,
        discussedAreas: area ? splitArea(area) : []
      }
    }
  };
}

function looksLikeDiaryImport(text) {
  if (/^生成日記本(?:\s|$)/u.test(text)) return true;
  const hasDiaryHeading = /旅行日記|日記文字版|行程總覽|待檢查清單/u.test(text);
  const hasStructuredTrip = /路線[:：]|時間[:：]|車次|上車地點[:：]|下車地點[:：]|報到時間[:：]/u.test(text);
  return hasDiaryHeading && hasStructuredTrip;
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function findTitleLine(text) {
  const markdownTitle = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (markdownTitle) return markdownTitle;

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const startIndex = lines[0] === "生成日記本" ? 1 : 0;
  for (const line of lines.slice(startIndex)) {
    if (SECTION_TITLES.has(line)) continue;
    if (/^\d{1,2}[/-]\d{1,2}/u.test(line)) continue;
    if (/^(第一段|第二段|第三段|第四段|交通)[:：]/u.test(line)) continue;
    if (/^(路線|時間|用途|車程|座位|人數|狀態|提醒)[:：]/u.test(line)) continue;
    return line;
  }
  return "";
}

function parseDateRange(text) {
  const match = String(text || "").match(DATE_RANGE_RE);
  if (!match) return { startDate: "", endDate: "" };
  const year = match[1];
  return {
    startDate: formatDate(year, match[2], match[3]),
    endDate: formatDate(match[4] || year, match[5], match[6])
  };
}

function buildTitle(titleLine, dateRange) {
  let title = String(titleLine || "新旅行日記")
    .replace(/^生成日記本\s*/u, "")
    .replace(/交通整理|行程整理|旅行日記/u, "")
    .trim();
  if (!title) title = "新旅行日記";
  if (dateRange.startDate && !title.includes(dateRange.startDate.slice(0, 4))) {
    title = `${dateRange.startDate.replaceAll("-", "/")}–${dateRange.endDate.replaceAll("-", "/")} ${title}`;
  }
  return title;
}

function inferArea(text) {
  const known = ["台北", "宜蘭", "高雄", "台中", "台南", "花蓮", "台東", "基隆", "新北", "桃園", "南港", "左營"];
  const found = known.filter((name) => text.includes(name));
  return Array.from(new Set(found)).slice(0, 4).join("、") || "未指定地區";
}

function splitArea(area) {
  return String(area || "")
    .split(/[、,，\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferPeopleCount(text) {
  return text.match(/人數[:：]\s*(\d+\s*人)/u)?.[1] || text.match(/共\s*(\d+)\s*張/u)?.[1]?.concat("人") || "";
}

function extractSection(text, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markdown = text.match(new RegExp(`##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "u"))?.[1];
  if (markdown) return cleanSection(markdown);

  const plain = text.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\n([\\s\\S]*)$`, "u"))?.[1];
  return cleanSection(plain || "");
}

function cleanSection(value) {
  return String(value || "")
    .replace(/^[-–—]{3,}$/gm, "")
    .replace(/^#+\s*/gm, "")
    .trim();
}

function parseItineraryItems(text, fallbackStartDate) {
  const lines = text.split("\n");
  const baseYear = fallbackStartDate?.slice(0, 4) || new Date().getFullYear().toString();
  const items = [];
  let currentDate = fallbackStartDate || "";
  let current = null;

  const flush = () => {
    if (!current) return;
    finalizeTransportItem(current);
    items.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "---") continue;
    if (/^(待檢查清單|日記文字版)$/u.test(line)) {
      flush();
      break;
    }

    const headingDate = line.match(/^(?:#{2,3}\s*)?(\d{1,2})[/-](\d{1,2})(?:\s*[｜|].*)?$/u);
    if (headingDate) {
      flush();
      currentDate = formatDate(baseYear, headingDate[1], headingDate[2]);
      continue;
    }

    const title = extractTransportTitle(line);
    if (title && isTransportTitle(title)) {
      flush();
      current = createTransportItem(title, currentDate);
      continue;
    }

    if (!current) continue;
    applyDetailLine(current, line, baseYear);
  }

  flush();
  return dedupeItems(items).slice(0, 30);
}

function extractTransportTitle(line) {
  const boldTitle = line.match(/^\*\*(.+?)\*\*/u)?.[1]?.trim();
  if (boldTitle) return normalizeBlockTitle(boldTitle);

  const segmentTitle = line.match(/^(?:第一段|第二段|第三段|第四段|交通)[:：]\s*(.+)$/u)?.[1]?.trim();
  if (segmentTitle) return normalizeBlockTitle(segmentTitle);

  return "";
}

function normalizeBlockTitle(value) {
  return String(value || "")
    .replace(/^第[一二三四五六七八九十]+段[:：]/u, "")
    .replace(/^交通[:：]/u, "")
    .replace(/[:：]$/u, "")
    .trim();
}

function createTransportItem(title, currentDate) {
  return {
    type: "transport",
    title,
    date: currentDate,
    time: "",
    endTime: "",
    area: "",
    place: title,
    transportMode: inferTransportMode(title),
    transportName: title,
    transportNumber: inferTransportNumber(title),
    fromPlace: "",
    toPlace: "",
    boardingPlace: "",
    duration: "",
    ticketStatus: "none",
    reservationStatus: "none",
    price: 0,
    note: ""
  };
}

function isTransportTitle(title) {
  return /台鐵|高鐵|火車|列車|海風號|觀光列車|捷運|客運|巴士|交通|飛機|航班|船/u.test(title);
}

function inferTransportMode(title) {
  if (/高鐵/u.test(title)) return "高鐵";
  if (/台鐵/u.test(title)) return "台鐵";
  if (/海風號|觀光列車/u.test(title)) return "觀光列車";
  if (/捷運/u.test(title)) return "捷運";
  if (/客運|巴士/u.test(title)) return "客運";
  if (/飛機|航班/u.test(title)) return "飛機";
  return "交通";
}

function inferTransportNumber(title) {
  return title.match(/(\d{3,5})\s*次/u)?.[1] || title.match(/\b(\d{3,5})\b/u)?.[1] || "";
}

function applyDetailLine(item, line, baseYear) {
  const colon = line.search(/[:：]/u);
  if (colon === -1) {
    appendNote(item, line);
    return;
  }

  const label = line.slice(0, colon).trim();
  const value = line.slice(colon + 1).trim();
  if (!value) return;

  if (label === "路線") {
    const route = value.split(/\s*(?:→|->|到)\s*/u).map((part) => part.trim()).filter(Boolean);
    item.fromPlace = route[0] || item.fromPlace;
    item.toPlace = route[1] || item.toPlace;
    item.area = [item.fromPlace, item.toPlace].filter(Boolean).join(" → ");
    item.place = item.area || item.place;
    return;
  }

  if (label === "時間") {
    const times = value.match(/\d{1,2}:\d{2}/gu) || [];
    item.time = times[0] || item.time;
    item.endTime = times[1] || item.endTime;
    const places = value.match(/([\u4e00-\u9fffA-Za-z0-9]+)\s*出發.*?抵達\s*([\u4e00-\u9fffA-Za-z0-9]+)/u);
    if (places) {
      item.fromPlace = item.fromPlace || places[1];
      item.toPlace = item.toPlace || places[2];
    }
    return;
  }

  if (label === "使用日期") {
    const date = value.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
    if (date) item.date = formatDate(date[1], date[2], date[3]);
    return;
  }

  if (label === "上車地點") {
    item.boardingPlace = value;
    item.fromPlace = item.fromPlace || value.replace(/站$/u, "");
    return;
  }

  if (label === "下車地點") {
    item.toPlace = item.toPlace || value.replace(/站$/u, "");
    return;
  }

  if (label === "車程") {
    item.duration = value;
    return;
  }

  if (/票價|合計|金額/u.test(label)) {
    item.price = parseMoney(value) || item.price;
    appendNote(item, `${label}：${value}`);
    return;
  }

  if (label === "狀態") {
    const status = normalizeItemStatus(value);
    item.ticketStatus = status;
    if (/訂位|座位/u.test(value)) item.reservationStatus = status;
    appendNote(item, `${label}：${value}`);
    return;
  }

  if (label === "報到時間") {
    const times = value.match(/\d{1,2}:\d{2}/gu) || [];
    item.time = item.time || times[0] || "";
    appendNote(item, `報到時間：${value}`);
    return;
  }

  if (label === "座位" && /待補|未/u.test(value)) {
    item.reservationStatus = "needed";
  }

  appendNote(item, `${label}：${value}`);
}

function normalizeItemStatus(value) {
  if (/已確認|已訂購|已訂位|已完成/u.test(value)) return "done";
  if (/待補|待確認|未/u.test(value)) return "needed";
  return "none";
}

function finalizeTransportItem(item) {
  if (!item.transportSummary) {
    const route = [item.fromPlace, item.toPlace].filter(Boolean).join(" → ");
    const time = [item.time, item.endTime].filter(Boolean).join("–");
    item.transportSummary = [item.transportName, item.transportNumber ? `${item.transportNumber} 次` : "", route, time, item.duration]
      .filter(Boolean)
      .join("，");
  }
  if (!item.area) item.area = [item.fromPlace, item.toPlace].filter(Boolean).join(" → ");
  if (!item.place) item.place = item.area || item.title;
}

function parseTodoTable(text) {
  const section = extractBetween(text, "待檢查清單", "日記文字版");
  const rows = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "待檢查清單") continue;
    if (/^項目\s+狀態\s+備註/u.test(trimmed) || /^項目\|狀態/u.test(trimmed)) continue;
    if (/^-+$|^\|\s*-+/u.test(trimmed)) continue;

    const cells = splitTodoCells(trimmed);
    if (cells.length < 2) continue;
    rows.push({
      title: cells[0],
      status: normalizeTodoStatus(cells[1]),
      category: inferTodoCategory(cells[0]),
      relatedTitle: cells[0],
      note: cells[2] || ""
    });
  }

  return rows.slice(0, 50);
}

function extractBetween(text, startTitle, endTitle) {
  const start = text.indexOf(startTitle);
  if (start === -1) return "";
  const afterStart = text.slice(start + startTitle.length);
  const end = afterStart.indexOf(endTitle);
  return end === -1 ? afterStart : afterStart.slice(0, end);
}

function splitTodoCells(line) {
  if (line.startsWith("|")) {
    return line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .filter((cell) => !/^---+$/.test(cell));
  }
  if (line.includes("\t")) {
    return line.split(/\t+/u).map((cell) => cell.trim()).filter(Boolean);
  }

  const statusPattern = TODO_STATUSES.join("|");
  const match = line.match(new RegExp(`^(.+?)\\s+(${statusPattern})(?:\\s+(.+))?$`, "u"));
  if (!match) return [];
  return [match[1], match[2], match[3] || ""].map((cell) => cell.trim()).filter(Boolean);
}

function normalizeTodoStatus(value) {
  if (/已確認|已訂購|已訂位|已完成/u.test(value)) return "done";
  if (/不用/u.test(value)) return "not_needed";
  if (/待確認|待補|未確認|需查/u.test(value)) return "confirm";
  return "todo";
}

function inferTodoCategory(title) {
  if (/高鐵|台鐵|海風號|交通|車|列車/u.test(title)) return "transport";
  if (/住宿|飯店|旅館/u.test(title)) return "lodging";
  if (/票|訂購|取票/u.test(title)) return "ticket";
  if (/訂位|餐廳/u.test(title)) return "reservation";
  return "other";
}

function parseMoney(value) {
  const match = String(value || "").match(/(?:NT\$|TWD|\$)?\s*([\d,]+)/iu);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function appendNote(item, line) {
  item.note = [item.note, line].filter(Boolean).join("\n");
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [item.date, item.title, item.time, item.fromPlace, item.toPlace].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

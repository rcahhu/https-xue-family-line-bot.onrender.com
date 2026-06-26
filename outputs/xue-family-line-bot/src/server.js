import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_OPENAI_MODEL } from "./ai.js";
import { DIARY_IMPORT_VERSION } from "./diaryImport.js";
import { handleLineEvent } from "./line.js";
import { getRecommendations } from "./recommendations.js";
import { HttpError, normalizeActor, TripStore } from "./storage.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await loadEnvFile(path.join(rootDir, ".env"));

const config = {
  appName: process.env.APP_NAME || "薛家好好玩",
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  liffId: process.env.LIFF_ID || "",
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || "",
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
  openaiEnableWebSearch: process.env.OPENAI_ENABLE_WEB_SEARCH !== "false",
  openaiMaxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 900),
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
  dataFile: process.env.DATA_FILE || path.join(rootDir, "data", "trips.json")
};

const publicDir = path.join(rootDir, "public");
const store = new TripStore(config.dataFile);

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    handleError(res, error);
  }
});

server.listen(config.port, () => {
  console.log(`${config.appName} is running at http://localhost:${config.port}`);
  console.log(`LINE webhook endpoint: ${config.baseUrl.replace(/\/$/, "")}/webhook`);
});

async function route(req, res) {
  const url = new URL(req.url, config.baseUrl);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, defaultHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, { ok: true, appName: config.appName, diaryImportVersion: DIARY_IMPORT_VERSION });
  }

  if (req.method === "POST" && pathname === "/webhook") {
    return handleWebhook(req, res);
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, pathname);
  }

  throw new HttpError(405, "Method not allowed");
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);
  if (!verifyLineSignature(rawBody, req.headers["x-line-signature"])) {
    throw new HttpError(401, "Invalid LINE signature");
  }

  const payload = JSON.parse(rawBody.toString("utf8") || "{}");
  const events = Array.isArray(payload.events) ? payload.events : [];
  await Promise.all(events.map((event) => handleLineEvent(event, { store, config })));
  return sendJson(res, { ok: true });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/uploads") {
    return handleUpload(req, res);
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return sendJson(res, {
      appName: config.appName,
      liffId: config.liffId,
      baseUrl: config.baseUrl
    });
  }

  if (req.method === "GET" && url.pathname === "/api/trips") {
    const trips = await store.listTrips({
      userId: url.searchParams.get("userId") || "",
      sourceKey: url.searchParams.get("sourceKey") || "",
      inviteKeys: (url.searchParams.get("invites") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    });
    return sendJson(res, { trips });
  }

  if (req.method === "POST" && url.pathname === "/api/trips") {
    const body = await readJson(req);
    const actor = normalizeActor(body.actor);
    const trip = await store.createTrip({
      title: body.title,
      area: body.area || body.title,
      startDate: body.startDate || "",
      endDate: body.endDate || "",
      note: body.note || "",
      peopleCount: body.peopleCount || "",
      stylePreference: body.stylePreference || "",
      lodgingPreference: body.lodgingPreference || "",
      coverPhotoUrl: body.coverPhotoUrl || "",
      owner: actor,
      sourceKey: body.sourceKey || ""
    });
    return sendJson(res, { trip }, 201);
  }

  if (parts[1] !== "trips" || !parts[2]) {
    throw new HttpError(404, "Not found");
  }

  const tripId = parts[2];
  const actorFromQuery = normalizeActor({
    lineUserId: url.searchParams.get("userId") || "",
    displayName: url.searchParams.get("displayName") || ""
  });
  const inviteToken = url.searchParams.get("invite") || "";

  if (req.method === "GET" && parts.length === 3) {
    const trip = await store.getTrip(tripId, {
      userId: actorFromQuery.lineUserId,
      inviteToken
    });
    return sendJson(res, { trip });
  }

  if (req.method === "PATCH" && parts.length === 3) {
    const body = await readJson(req);
    const trip = await store.updateTrip(tripId, body.patch || body, normalizeActor(body.actor));
    return sendJson(res, { trip });
  }

  if (req.method === "DELETE" && parts.length === 3) {
    const body = await readJson(req);
    const result = await store.deleteTrip(tripId, normalizeActor(body.actor));
    return sendJson(res, result);
  }

  if (req.method === "POST" && parts[3] === "join") {
    const body = await readJson(req);
    const result = await store.joinTrip(tripId, {
      inviteToken: body.inviteToken,
      actor: normalizeActor(body.actor),
      sourceKey: body.sourceKey || ""
    });
    return sendJson(res, result);
  }

  if (req.method === "GET" && parts[3] === "recommendations") {
    const trip = await store.getTrip(tripId, {
      userId: actorFromQuery.lineUserId,
      inviteToken
    });
    const recommendations = getRecommendations({
      area: url.searchParams.get("area") || trip.area,
      lat: url.searchParams.get("lat"),
      lng: url.searchParams.get("lng")
    });
    return sendJson(res, { recommendations });
  }

  if (parts[3] === "itinerary") {
    return handleItineraryApi(req, res, tripId, parts);
  }

  if (parts[3] === "wishes") {
    return handleWishesApi(req, res, tripId, parts);
  }

  if (parts[3] === "todos") {
    return handleTodosApi(req, res, tripId, parts);
  }

  throw new HttpError(404, "Not found");
}

async function handleUpload(req, res) {
  const upload = await readMultipartFile(req, 8 * 1024 * 1024);
  if (!upload) throw new HttpError(400, "沒有收到照片檔案");
  if (!upload.contentType.startsWith("image/")) {
    throw new HttpError(400, "只能上傳圖片");
  }

  const uploadsDir = path.join(publicDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extensionForMime(upload.contentType)}`;
  await fs.writeFile(path.join(uploadsDir, filename), upload.data);
  return sendJson(res, { url: `/uploads/${filename}` }, 201);
}

async function handleItineraryApi(req, res, tripId, parts) {
  if (req.method === "POST" && parts.length === 4) {
    const body = await readJson(req);
    const item = await store.addItineraryItem(tripId, body.item || body, normalizeActor(body.actor));
    return sendJson(res, { item }, 201);
  }

  if (req.method === "PATCH" && parts.length === 5) {
    const body = await readJson(req);
    const item = await store.updateItineraryItem(
      tripId,
      parts[4],
      body.patch || body,
      normalizeActor(body.actor)
    );
    return sendJson(res, { item });
  }

  if (req.method === "DELETE" && parts.length === 5) {
    const body = await readJson(req);
    const result = await store.deleteItineraryItem(tripId, parts[4], normalizeActor(body.actor));
    return sendJson(res, result);
  }

  throw new HttpError(404, "Not found");
}

async function handleWishesApi(req, res, tripId, parts) {
  if (req.method === "POST" && parts.length === 4) {
    const body = await readJson(req);
    const wish = await store.addWish(tripId, body.wish || body, normalizeActor(body.actor));
    return sendJson(res, { wish }, 201);
  }

  if (req.method === "PATCH" && parts.length === 5) {
    const body = await readJson(req);
    const wish = await store.updateWish(tripId, parts[4], body.patch || body, normalizeActor(body.actor));
    return sendJson(res, { wish });
  }

  if (req.method === "DELETE" && parts.length === 5) {
    const body = await readJson(req);
    const result = await store.deleteWish(tripId, parts[4], normalizeActor(body.actor));
    return sendJson(res, result);
  }

  throw new HttpError(404, "Not found");
}

async function handleTodosApi(req, res, tripId, parts) {
  if (req.method === "POST" && parts.length === 4) {
    const body = await readJson(req);
    const todo = await store.addTodoItem(tripId, body.todo || body, normalizeActor(body.actor));
    return sendJson(res, { todo }, 201);
  }

  if (req.method === "PATCH" && parts.length === 5) {
    const body = await readJson(req);
    const todo = await store.updateTodoItem(tripId, parts[4], body.patch || body, normalizeActor(body.actor));
    return sendJson(res, { todo });
  }

  if (req.method === "DELETE" && parts.length === 5) {
    const body = await readJson(req);
    const result = await store.deleteTodoItem(tripId, parts[4], normalizeActor(body.actor));
    return sendJson(res, result);
  }

  throw new HttpError(404, "Not found");
}

async function serveStatic(req, res, pathname) {
  const normalizedPath = pathname === "/" || pathname === "/app" ? "/index.html" : pathname;
  const target = path.resolve(publicDir, `.${normalizedPath}`);
  if (!target.startsWith(publicDir)) throw new HttpError(403, "Forbidden");

  try {
    const file = await fs.readFile(target);
    res.writeHead(200, {
      ...defaultHeaders(),
      "Content-Type": contentType(path.extname(target)),
      "Cache-Control": "no-store"
    });
    if (req.method !== "HEAD") res.end(file);
    else res.end();
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "Not found");
    throw error;
  }
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readMultipartFile(req, limit) {
  const contentTypeHeader = req.headers["content-type"] || "";
  const boundary = String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] ||
    String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new HttpError(400, "上傳格式不正確");

  const body = await readBody(req, limit);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, boundaryBuffer);

  for (let part of parts) {
    if (!part.length) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    let data = part.subarray(headerEnd + 4);
    if (data.subarray(-2).toString() === "\r\n") data = data.subarray(0, -2);
    if (!/filename=/i.test(headerText)) continue;
    const contentType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream";
    return { contentType, data };
  }
  return null;
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function verifyLineSignature(rawBody, signature) {
  if (!config.lineChannelSecret) return true;
  if (!signature || typeof signature !== "string") return false;
  const digest = crypto
    .createHmac("sha256", config.lineChannelSecret)
    .update(rawBody)
    .digest("base64");
  const actual = Buffer.from(signature);
  const expected = Buffer.from(digest);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    ...defaultHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(value));
}

function handleError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  sendJson(
    res,
    {
      ok: false,
      error: error.message || "Internal Server Error"
    },
    status
  );
}

function defaultHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  };
}

function contentType(extname) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  };
  return types[extname] || "application/octet-stream";
}

function extensionForMime(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp"
  };
  return map[mimeType.toLowerCase()] || ".jpg";
}

function loadEnvFile(filePath) {
  return fs
    .readFile(filePath, "utf8")
    .then((content) => {
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [key, ...rest] = trimmed.split("=");
        if (!key || process.env[key]) continue;
        process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
      }
    })
    .catch(() => {});
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const emptyDatabase = {
  version: 3,
  trips: []
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class TripStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.ready = this.ensureDatabase();
  }

  async ensureDatabase() {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
    try {
      await fs.access(this.dataFile);
    } catch {
      await fs.writeFile(this.dataFile, JSON.stringify(emptyDatabase, null, 2));
    }
  }

  async read() {
    await this.ready;
    const raw = await fs.readFile(this.dataFile, "utf8");
    const db = JSON.parse(raw || "{}");
    if (!Array.isArray(db.trips)) db.trips = [];
    db.version = Math.max(Number(db.version || 1), emptyDatabase.version);
    db.trips.forEach(hydrateTrip);
    return db;
  }

  async write(db) {
    await this.ready;
    const tmpFile = `${this.dataFile}.${process.pid}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(db, null, 2)}\n`);
    await fs.rename(tmpFile, this.dataFile);
  }

  async mutate(fn) {
    const db = await this.read();
    const result = await fn(db);
    await this.write(db);
    return result;
  }

  async listTrips({ userId, sourceKey, inviteKeys = [] } = {}) {
    const db = await this.read();
    const inviteMap = normalizeInviteKeys(inviteKeys);
    return db.trips
      .filter((trip) => canSeeTrip(trip, { userId, sourceKey }) || hasInviteKey(trip, inviteMap))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getTrip(id, { userId, sourceKey, inviteToken, allowPublic = false } = {}) {
    const db = await this.read();
    const trip = db.trips.find((item) => item.id === id);
    if (!trip) throw new HttpError(404, "找不到這本旅行日記");
    if (
      !allowPublic &&
      inviteToken !== trip.inviteToken &&
      !canSeeTrip(trip, { userId, sourceKey })
    ) {
      throw new HttpError(403, "你還不是這本旅行日記的成員");
    }
    return trip;
  }

  async createTrip({
    title,
    area,
    startDate,
    endDate,
    note,
    peopleCount,
    stylePreference,
    lodgingPreference,
    coverPhotoUrl,
    planning,
    owner,
    sourceKey
  }) {
    return this.mutate((db) => {
      const now = new Date().toISOString();
      const actor = normalizeActor(owner);
      const trip = {
        id: createId("trip"),
        title: cleanText(title) || "未命名旅行",
        area: cleanText(area || title) || "未設定地區",
        startDate: cleanText(startDate),
        endDate: cleanText(endDate),
        note: cleanText(note),
        peopleCount: cleanText(peopleCount),
        stylePreference: cleanText(stylePreference),
        lodgingPreference: cleanText(lodgingPreference),
        coverPhotoUrl: normalizePhotoUrl(coverPhotoUrl),
        planning: normalizePlanning(planning),
        inviteToken: createId("invite"),
        createdAt: now,
        updatedAt: now,
        owner: actor,
        createdBy: actor,
        updatedBy: actor,
        sourceKeys: sourceKey ? [sourceKey] : [],
        members: [
          {
            ...actor,
            role: "owner",
            joinedAt: now
          }
        ],
        itinerary: [],
        todos: [],
        wishes: []
      };
      db.trips.push(trip);
      return trip;
    });
  }

  async updateTrip(id, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      if (patch.title !== undefined) trip.title = cleanText(patch.title) || trip.title;
      if (patch.area !== undefined) trip.area = cleanText(patch.area) || trip.area;
      if (patch.startDate !== undefined) trip.startDate = cleanText(patch.startDate);
      if (patch.endDate !== undefined) trip.endDate = cleanText(patch.endDate);
      if (patch.note !== undefined) trip.note = cleanText(patch.note);
      if (patch.peopleCount !== undefined) trip.peopleCount = cleanText(patch.peopleCount);
      if (patch.stylePreference !== undefined) trip.stylePreference = cleanText(patch.stylePreference);
      if (patch.lodgingPreference !== undefined) trip.lodgingPreference = cleanText(patch.lodgingPreference);
      if (patch.coverPhotoUrl !== undefined) trip.coverPhotoUrl = normalizePhotoUrl(patch.coverPhotoUrl);
      if (patch.planning !== undefined) {
        trip.planning = normalizePlanning({
          ...trip.planning,
          ...patch.planning
        });
      }
      touch(trip, normalizedActor);
      return trip;
    });
  }

  async deleteTrip(id, actor = {}) {
    return this.mutate((db) => {
      const index = db.trips.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, "找不到這本旅行日記");
      requireMember(db.trips[index], actor);
      db.trips.splice(index, 1);
      return { ok: true };
    });
  }

  async joinTrip(id, { inviteToken, actor, sourceKey }) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      if (trip.inviteToken !== inviteToken) {
        throw new HttpError(403, "邀請連結已失效或不正確");
      }
      const member = upsertMember(trip, actor, "member");
      if (sourceKey && !trip.sourceKeys.includes(sourceKey)) {
        trip.sourceKeys.push(sourceKey);
      }
      touch(trip, member);
      return { trip, member };
    });
  }

  async linkTripToSource(id, sourceKey, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const normalizedActor = normalizeActor(actor);
      if (sourceKey && !trip.sourceKeys.includes(sourceKey)) {
        trip.sourceKeys.push(sourceKey);
      }
      touch(trip, normalizedActor);
      return trip;
    });
  }

  async addItineraryItem(id, item, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const now = new Date().toISOString();
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      const itineraryItem = normalizeItineraryItem({
        ...item,
        id: createId("item"),
        createdAt: now,
        updatedAt: now,
        createdBy: normalizedActor,
        updatedBy: normalizedActor
      });
      trip.itinerary.push(itineraryItem);
      sortItinerary(trip);
      touch(trip, normalizedActor);
      return itineraryItem;
    });
  }

  async updateItineraryItem(id, itemId, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const item = trip.itinerary.find((entry) => entry.id === itemId);
      if (!item) throw new HttpError(404, "找不到這個行程");
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      Object.assign(
        item,
        normalizeItineraryItem({
          ...item,
          ...patch,
          id: item.id,
          createdAt: item.createdAt,
          createdBy: item.createdBy,
          updatedAt: new Date().toISOString(),
          updatedBy: normalizedActor
        })
      );
      sortItinerary(trip);
      touch(trip, normalizedActor);
      return item;
    });
  }

  async deleteItineraryItem(id, itemId, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const before = trip.itinerary.length;
      trip.itinerary = trip.itinerary.filter((entry) => entry.id !== itemId);
      if (trip.itinerary.length === before) throw new HttpError(404, "找不到這個行程");
      touch(trip, normalizeActor(actor));
      return { ok: true };
    });
  }

  async addTodoItem(id, todo, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const now = new Date().toISOString();
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      const createdTodo = normalizeTodoItem({
        ...todo,
        id: createId("todo"),
        createdAt: now,
        updatedAt: now,
        createdBy: normalizedActor,
        updatedBy: normalizedActor
      });
      if (!createdTodo.title) throw new HttpError(400, "待辦內容不能空白");
      trip.todos.unshift(createdTodo);
      touch(trip, normalizedActor);
      return createdTodo;
    });
  }

  async upsertTodoItem(id, todo, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      const normalized = normalizeTodoItem({
        ...todo,
        createdBy: normalizedActor,
        updatedBy: normalizedActor
      });
      if (!normalized.title) throw new HttpError(400, "待辦內容不能空白");
      const existing = trip.todos.find((entry) => todoKey(entry) === todoKey(normalized));
      if (existing) {
        Object.assign(existing, {
          ...existing,
          ...normalized,
          id: existing.id,
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
          updatedAt: new Date().toISOString(),
          updatedBy: normalizedActor
        });
        touch(trip, normalizedActor);
        return existing;
      }
      const now = new Date().toISOString();
      const createdTodo = normalizeTodoItem({
        ...normalized,
        id: createId("todo"),
        createdAt: now,
        updatedAt: now,
        createdBy: normalizedActor,
        updatedBy: normalizedActor
      });
      trip.todos.unshift(createdTodo);
      touch(trip, normalizedActor);
      return createdTodo;
    });
  }

  async updateTodoItem(id, todoId, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const todo = trip.todos.find((entry) => entry.id === todoId);
      if (!todo) throw new HttpError(404, "找不到這個待辦");
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      Object.assign(
        todo,
        normalizeTodoItem({
          ...todo,
          ...patch,
          id: todo.id,
          createdAt: todo.createdAt,
          createdBy: todo.createdBy,
          updatedAt: new Date().toISOString(),
          updatedBy: normalizedActor
        })
      );
      touch(trip, normalizedActor);
      return todo;
    });
  }

  async deleteTodoItem(id, todoId, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const before = trip.todos.length;
      trip.todos = trip.todos.filter((entry) => entry.id !== todoId);
      if (trip.todos.length === before) throw new HttpError(404, "找不到這個待辦");
      touch(trip, normalizeActor(actor));
      return { ok: true };
    });
  }

  async addWish(id, wish, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const now = new Date().toISOString();
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      const createdWish = {
        id: createId("wish"),
        type: normalizeWishType(wish.type),
        text: cleanText(wish.text),
        status: normalizeWishStatus(wish.status),
        author: normalizedActor,
        createdBy: normalizedActor,
        updatedBy: normalizedActor,
        createdAt: now,
        updatedAt: now
      };
      if (!createdWish.text) throw new HttpError(400, "許願內容不能空白");
      trip.wishes.unshift(createdWish);
      touch(trip, normalizedActor);
      return createdWish;
    });
  }

  async updateWish(id, wishId, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const wish = trip.wishes.find((entry) => entry.id === wishId);
      if (!wish) throw new HttpError(404, "找不到這個願望");
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      if (patch.type !== undefined) wish.type = normalizeWishType(patch.type);
      if (patch.text !== undefined) wish.text = cleanText(patch.text);
      if (patch.status !== undefined) wish.status = normalizeWishStatus(patch.status);
      wish.updatedBy = normalizedActor;
      wish.updatedAt = new Date().toISOString();
      touch(trip, normalizedActor);
      return wish;
    });
  }

  async deleteWish(id, wishId, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const before = trip.wishes.length;
      trip.wishes = trip.wishes.filter((entry) => entry.id !== wishId);
      if (trip.wishes.length === before) throw new HttpError(404, "找不到這個願望");
      touch(trip, normalizeActor(actor));
      return { ok: true };
    });
  }

  async findActiveTrip({ userId, sourceKey }) {
    const trips = await this.listTrips({ userId, sourceKey });
    return trips[0] || null;
  }
}

export function normalizeActor(actor = {}) {
  const lineUserId = cleanText(actor.lineUserId || actor.userId || "guest");
  return {
    lineUserId,
    displayName: cleanText(actor.displayName || actor.name || "旅伴")
  };
}

export function makeSourceKey(source = {}) {
  if (source.groupId) return `group:${source.groupId}`;
  if (source.roomId) return `room:${source.roomId}`;
  if (source.userId) return `user:${source.userId}`;
  return "";
}

function hydrateTrip(trip) {
  const actor = normalizeActor(trip.owner || trip.createdBy || { displayName: "旅伴" });
  trip.owner = normalizeActor(trip.owner || actor);
  trip.createdBy = normalizeActor(trip.createdBy || trip.owner);
  trip.updatedBy = normalizeActor(trip.updatedBy || trip.owner);
  trip.sourceKeys = Array.isArray(trip.sourceKeys) ? trip.sourceKeys : [];
  trip.startDate = cleanText(trip.startDate);
  trip.endDate = cleanText(trip.endDate);
  trip.note = cleanText(trip.note);
  trip.peopleCount = cleanText(trip.peopleCount);
  trip.stylePreference = cleanText(trip.stylePreference);
  trip.lodgingPreference = cleanText(trip.lodgingPreference);
  trip.coverPhotoUrl = normalizePhotoUrl(trip.coverPhotoUrl);
  trip.planning = normalizePlanning(trip.planning);
  trip.members = Array.isArray(trip.members) ? trip.members.map(hydrateMember) : [];
  if (!trip.members.some((member) => member.lineUserId === trip.owner.lineUserId)) {
    trip.members.unshift({
      ...trip.owner,
      role: "owner",
      joinedAt: trip.createdAt || new Date().toISOString()
    });
  }
  trip.itinerary = Array.isArray(trip.itinerary)
    ? trip.itinerary.map((item) => normalizeItineraryItem(item))
    : [];
  trip.todos = Array.isArray(trip.todos) ? trip.todos.map(hydrateTodo) : [];
  trip.wishes = Array.isArray(trip.wishes) ? trip.wishes.map(hydrateWish) : [];
  return trip;
}

function hydrateMember(member) {
  return {
    ...normalizeActor(member),
    role: member.role === "owner" ? "owner" : "member",
    joinedAt: member.joinedAt || new Date().toISOString()
  };
}

function hydrateWish(wish) {
  const author = normalizeActor(wish.author || wish.createdBy || { displayName: "旅伴" });
  return {
    ...wish,
    type: normalizeWishType(wish.type),
    text: cleanText(wish.text),
    status: normalizeWishStatus(wish.status),
    author,
    createdBy: normalizeActor(wish.createdBy || author),
    updatedBy: normalizeActor(wish.updatedBy || wish.createdBy || author),
    createdAt: wish.createdAt || new Date().toISOString(),
    updatedAt: wish.updatedAt || wish.createdAt || new Date().toISOString()
  };
}

function hydrateTodo(todo) {
  const createdBy = normalizeActor(todo.createdBy || { displayName: "旅伴" });
  return normalizeTodoItem({
    ...todo,
    createdBy,
    updatedBy: normalizeActor(todo.updatedBy || createdBy),
    createdAt: todo.createdAt || new Date().toISOString(),
    updatedAt: todo.updatedAt || todo.createdAt || new Date().toISOString()
  });
}

function canSeeTrip(trip, { userId, sourceKey } = {}) {
  if (sourceKey && trip.sourceKeys?.includes(sourceKey)) return true;
  if (!userId) return false;
  if (trip.owner?.lineUserId === userId) return true;
  return trip.members?.some((member) => member.lineUserId === userId);
}

function normalizeInviteKeys(inviteKeys = []) {
  const map = new Map();
  for (const entry of inviteKeys) {
    const [tripId, inviteToken] = String(entry || "").split(":");
    if (tripId && inviteToken) map.set(tripId, inviteToken);
  }
  return map;
}

function hasInviteKey(trip, inviteMap) {
  return inviteMap.get(trip.id) === trip.inviteToken;
}

function findTrip(db, id) {
  const trip = db.trips.find((item) => item.id === id);
  if (!trip) throw new HttpError(404, "找不到這本旅行日記");
  return trip;
}

function requireMember(trip, actor = {}) {
  const userId = actor.lineUserId || actor.userId;
  const sourceKey = actor.sourceKey || "";
  if (!userId && !sourceKey) throw new HttpError(401, "需要 LINE 使用者身份");
  if (!canSeeTrip(trip, { userId, sourceKey })) {
    throw new HttpError(403, "你還不是這本旅行日記的成員");
  }
}

function upsertMember(trip, actor = {}, role = "member") {
  const normalized = normalizeActor(actor);
  const existing = trip.members.find((member) => member.lineUserId === normalized.lineUserId);
  if (existing) {
    existing.displayName = normalized.displayName;
    return existing;
  }
  const member = {
    ...normalized,
    role,
    joinedAt: new Date().toISOString()
  };
  trip.members.push(member);
  return member;
}

function normalizeItineraryItem(item = {}) {
  const createdBy = normalizeActor(item.createdBy || { displayName: "旅伴" });
  return {
    id: item.id,
    type: normalizeItineraryType(item.type),
    title: cleanText(item.title) || "未命名行程",
    place: cleanText(item.place),
    date: cleanText(item.date),
    time: cleanText(item.time),
    endDate: cleanText(item.endDate),
    endTime: cleanText(item.endTime),
    note: cleanText(item.note),
    day: cleanText(item.day),
    area: cleanText(item.area),
    photoUrls: normalizePhotoUrls(item.photoUrls),
    ticketStatus: normalizeStatus(item.ticketStatus),
    reservationStatus: normalizeStatus(item.reservationStatus),
    price: normalizePrice(item.price),
    currency: cleanText(item.currency || "TWD") || "TWD",
    transportMode: cleanText(item.transportMode),
    transportSummary: cleanText(item.transportSummary),
    transportName: cleanText(item.transportName),
    transportNumber: cleanText(item.transportNumber),
    fromPlace: cleanText(item.fromPlace),
    toPlace: cleanText(item.toPlace),
    boardingPlace: cleanText(item.boardingPlace),
    duration: cleanText(item.duration),
    lodgingName: cleanText(item.lodgingName),
    lodgingSummary: cleanText(item.lodgingSummary),
    lodgingAddress: cleanText(item.lodgingAddress),
    checkInDate: cleanText(item.checkInDate),
    checkOutDate: cleanText(item.checkOutDate),
    breakfast: normalizeBreakfast(item.breakfast),
    confirmationNumber: cleanText(item.confirmationNumber),
    createdBy,
    updatedBy: normalizeActor(item.updatedBy || createdBy),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  };
}

function normalizeTodoItem(todo = {}) {
  const createdBy = normalizeActor(todo.createdBy || { displayName: "旅伴" });
  return {
    id: todo.id,
    title: cleanText(todo.title),
    category: normalizeTodoCategory(todo.category),
    status: normalizeTodoStatus(todo.status),
    relatedItemId: cleanText(todo.relatedItemId),
    relatedTitle: cleanText(todo.relatedTitle),
    note: cleanText(todo.note),
    createdBy,
    updatedBy: normalizeActor(todo.updatedBy || createdBy),
    createdAt: todo.createdAt || new Date().toISOString(),
    updatedAt: todo.updatedAt || todo.createdAt || new Date().toISOString()
  };
}

function normalizeItineraryType(value) {
  const allowed = new Set(["activity", "transport", "lodging"]);
  return allowed.has(value) ? value : "activity";
}

function normalizeStatus(value) {
  const allowed = new Set(["none", "needed", "done"]);
  return allowed.has(value) ? value : "none";
}

function normalizeTodoCategory(value) {
  const allowed = new Set([
    "flight",
    "lodging",
    "ticket",
    "reservation",
    "hours",
    "transport",
    "insurance",
    "esim",
    "packing",
    "other"
  ]);
  return allowed.has(value) ? value : "other";
}

function normalizeTodoStatus(value) {
  const allowed = new Set([
    "todo",
    "done",
    "not_needed",
    "confirm",
    "need_ticket",
    "need_reservation",
    "need_hours",
    "need_transport"
  ]);
  return allowed.has(value) ? value : "todo";
}

function normalizeBreakfast(value) {
  const allowed = new Set(["unknown", "included", "not_included"]);
  return allowed.has(value) ? value : "unknown";
}

function normalizeWishType(value) {
  const allowed = new Set(["food", "spot", "activity", "other"]);
  return allowed.has(value) ? value : "other";
}

function normalizeWishStatus(value) {
  const allowed = new Set(["open", "planned", "done"]);
  return allowed.has(value) ? value : "open";
}

function normalizePrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function sortItinerary(trip) {
  trip.itinerary.sort((a, b) => {
    const left = `${scheduleDate(a) || "9999-12-31"} ${a.time || "99:99"}`;
    const right = `${scheduleDate(b) || "9999-12-31"} ${b.time || "99:99"}`;
    return left.localeCompare(right);
  });
}

function scheduleDate(item) {
  if (item.date || item.checkInDate) return item.date || item.checkInDate;
  if (item.day) return `0000-00-${String(item.day).padStart(2, "0")}`;
  return item.createdAt?.slice(0, 10) || "";
}

function touch(trip, actor = {}) {
  trip.updatedAt = new Date().toISOString();
  trip.updatedBy = normalizeActor(actor || trip.updatedBy || trip.owner);
}

function cleanText(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function normalizePlanning(value = {}) {
  const recommendedPlaces = Array.isArray(value.recommendedPlaces) ? value.recommendedPlaces : [];
  const rejectedPlaces = Array.isArray(value.rejectedPlaces) ? value.rejectedPlaces : [];
  const discussedAreas = Array.isArray(value.discussedAreas) ? value.discussedAreas : [];
  return {
    phase: cleanText(value.phase || "planning"),
    currentArea: cleanText(value.currentArea),
    lastQuestion: cleanText(value.lastQuestion),
    recommendedPlaces: uniqueClean(recommendedPlaces),
    rejectedPlaces: uniqueClean(rejectedPlaces),
    discussedAreas: uniqueClean(discussedAreas)
  };
}

function uniqueClean(values) {
  return Array.from(new Set(values.map(cleanText).filter(Boolean))).slice(0, 120);
}

function normalizePhotoUrl(value) {
  const url = cleanText(value);
  if (!isAllowedPhotoUrl(url)) return "";
  return url;
}

function normalizePhotoUrls(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\s,，\n]+/)
        .filter(Boolean);
  return uniqueClean(values).filter(isAllowedPhotoUrl).slice(0, 12);
}

function isAllowedPhotoUrl(url) {
  return /^https?:\/\//i.test(url) || /^\/uploads\/[A-Za-z0-9._-]+$/u.test(url);
}

function todoKey(todo) {
  return `${normalizeTodoCategory(todo.category)}:${cleanText(todo.relatedTitle || todo.title).toLowerCase()}`;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

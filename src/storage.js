import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const emptyDatabase = {
  version: 2,
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

  async listTrips({ userId, sourceKey } = {}) {
    const db = await this.read();
    return db.trips
      .filter((trip) => canSeeTrip(trip, { userId, sourceKey }))
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

  async createTrip({ title, area, startDate, endDate, note, owner, sourceKey }) {
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

function canSeeTrip(trip, { userId, sourceKey } = {}) {
  if (sourceKey && trip.sourceKeys?.includes(sourceKey)) return true;
  if (!userId) return false;
  if (trip.owner?.lineUserId === userId) return true;
  return trip.members?.some((member) => member.lineUserId === userId);
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

function normalizeItineraryType(value) {
  const allowed = new Set(["activity", "transport", "lodging"]);
  return allowed.has(value) ? value : "activity";
}

function normalizeStatus(value) {
  const allowed = new Set(["none", "needed", "done"]);
  return allowed.has(value) ? value : "none";
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
  return item.date || item.checkInDate || item.createdAt?.slice(0, 10) || "";
}

function touch(trip, actor = {}) {
  trip.updatedAt = new Date().toISOString();
  trip.updatedBy = normalizeActor(actor || trip.updatedBy || trip.owner);
}

function cleanText(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

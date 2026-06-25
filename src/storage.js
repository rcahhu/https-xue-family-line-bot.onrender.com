import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const emptyDatabase = {
  version: 1,
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

  async createTrip({ title, area, owner, sourceKey }) {
    return this.mutate((db) => {
      const now = new Date().toISOString();
      const trip = {
        id: createId("trip"),
        title: cleanText(title) || "未命名旅行",
        area: cleanText(area || title) || "未設定地區",
        inviteToken: createId("invite"),
        createdAt: now,
        updatedAt: now,
        owner: normalizeActor(owner),
        sourceKeys: sourceKey ? [sourceKey] : [],
        members: [
          {
            ...normalizeActor(owner),
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
      if (patch.title !== undefined) trip.title = cleanText(patch.title) || trip.title;
      if (patch.area !== undefined) trip.area = cleanText(patch.area) || trip.area;
      touch(trip);
      return trip;
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
      touch(trip);
      return { trip, member };
    });
  }

  async linkTripToSource(id, sourceKey, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      if (sourceKey && !trip.sourceKeys.includes(sourceKey)) {
        trip.sourceKeys.push(sourceKey);
      }
      touch(trip);
      return trip;
    });
  }

  async addItineraryItem(id, item, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const now = new Date().toISOString();
      const itineraryItem = normalizeItineraryItem({
        ...item,
        id: createId("item"),
        createdAt: now,
        updatedAt: now
      });
      trip.itinerary.push(itineraryItem);
      sortItinerary(trip);
      touch(trip);
      return itineraryItem;
    });
  }

  async updateItineraryItem(id, itemId, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const item = trip.itinerary.find((entry) => entry.id === itemId);
      if (!item) throw new HttpError(404, "找不到這個行程");
      Object.assign(item, normalizeItineraryItem({ ...item, ...patch, id: item.id }));
      item.updatedAt = new Date().toISOString();
      sortItinerary(trip);
      touch(trip);
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
      touch(trip);
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
        createdAt: now,
        updatedAt: now
      };
      if (!createdWish.text) throw new HttpError(400, "許願內容不能空白");
      trip.wishes.unshift(createdWish);
      touch(trip);
      return createdWish;
    });
  }

  async updateWish(id, wishId, patch, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const wish = trip.wishes.find((entry) => entry.id === wishId);
      if (!wish) throw new HttpError(404, "找不到這個願望");
      if (patch.type !== undefined) wish.type = normalizeWishType(patch.type);
      if (patch.text !== undefined) wish.text = cleanText(patch.text);
      if (patch.status !== undefined) wish.status = normalizeWishStatus(patch.status);
      wish.updatedAt = new Date().toISOString();
      touch(trip);
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
      touch(trip);
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
  return {
    id: item.id,
    title: cleanText(item.title) || "未命名行程",
    place: cleanText(item.place),
    date: cleanText(item.date),
    time: cleanText(item.time),
    note: cleanText(item.note),
    ticketStatus: normalizeStatus(item.ticketStatus),
    reservationStatus: normalizeStatus(item.reservationStatus),
    price: normalizePrice(item.price),
    currency: cleanText(item.currency || "TWD") || "TWD",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function normalizeStatus(value) {
  const allowed = new Set(["none", "needed", "done"]);
  return allowed.has(value) ? value : "none";
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
    const left = `${a.date || "9999-12-31"} ${a.time || "99:99"}`;
    const right = `${b.date || "9999-12-31"} ${b.time || "99:99"}`;
    return left.localeCompare(right);
  });
}

function touch(trip) {
  trip.updatedAt = new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? "").trim().slice(0, 2000);
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

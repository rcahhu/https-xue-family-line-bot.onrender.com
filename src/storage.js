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
  constructor(dataFile, options = {}) {
    this.dataFile = dataFile;
    this.ready = options.autoEnsure === false ? Promise.resolve() : this.ensureDatabase();
    this.writeQueue = Promise.resolve();
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
    const run = async () => {
      const db = await this.read();
      const result = await fn(db);
      await this.write(db);
      return result;
    };

    const operation = this.writeQueue.then(run, run);
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async listTrips({ userId, sourceKey, inviteKeys = [], includeAll = false } = {}) {
    const db = await this.read();
    const inviteMap = normalizeInviteKeys(inviteKeys);
    const trips = includeAll
      ? db.trips
      : db.trips.filter((trip) => canSeeTrip(trip, { userId, sourceKey }) || hasInviteKey(trip, inviteMap));
    return trips.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, member);
      if (sourceKey && !trip.sourceKeys.includes(sourceKey)) {
        trip.sourceKeys.push(sourceKey);
      }
      touch(trip, member);
      return { trip, member };
    });
  }

  async addManualMember(id, memberInput = {}, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const displayName = cleanText(memberInput.displayName || memberInput.name);
      if (!displayName) throw new HttpError(400, "同行成員名稱不能空白");
      const existing = (trip.members || []).find(
        (member) => sameDisplayName(member.displayName, displayName)
      );
      if (existing) return existing;
      const member = {
        lineUserId: `manual:${createId("member")}`,
        displayName,
        role: "manual",
        manual: true,
        joinedAt: new Date().toISOString()
      };
      trip.members = Array.isArray(trip.members) ? trip.members : [];
      trip.members.push(member);
      touch(trip, normalizeActor(actor));
      return member;
    });
  }

  async linkTripToSource(id, sourceKey, actor = {}) {
    return this.mutate((db) => {
      const trip = findTrip(db, id);
      requireMember(trip, actor);
      const normalizedActor = normalizeActor(actor);
      upsertMember(trip, normalizedActor, "member");
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, actor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, actor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, normalizedActor);
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
      upgradeActorNames(trip, actor);
      touch(trip, normalizeActor(actor));
      return { ok: true };
    });
  }

  async findActiveTrip({ userId, sourceKey }) {
    const trips = await this.listTrips({ userId, sourceKey });
    return trips[0] || null;
  }
}

export function createTripStore(config = {}) {
  if (shouldUseSupabase(config)) {
    return new SupabaseTripStore({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      tableName: config.supabaseStateTable || "xuebot_state",
      stateId: config.supabaseStateId || "default",
      localSeedFile: config.dataFile
    });
  }
  return new TripStore(config.dataFile);
}

export function createSupabasePhotoUploader(config = {}) {
  if (!shouldUseSupabase(config)) return null;
  return new SupabasePhotoUploader({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    bucket: config.supabaseStorageBucket || "xuebot-photos"
  });
}

function shouldUseSupabase(config = {}) {
  const backend = cleanText(config.storageBackend || process.env.STORAGE_BACKEND || "").toLowerCase();
  const hasSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
  if (backend === "json") return false;
  if (backend === "supabase" && !hasSupabase) {
    throw new Error("STORAGE_BACKEND=supabase 時，必須同時設定 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY");
  }
  return hasSupabase;
}

class SupabaseTripStore extends TripStore {
  constructor({ supabaseUrl, serviceRoleKey, tableName, stateId, localSeedFile }) {
    super("supabase", { autoEnsure: false });
    this.client = new SupabaseRestClient({ supabaseUrl, serviceRoleKey });
    this.tableName = tableName;
    this.stateId = stateId;
    this.localSeedFile = localSeedFile;
    this.ready = this.ensureDatabase();
  }

  async ensureDatabase() {
    const existing = await this.fetchState({ allowMissing: true });
    if (existing) return;
    const seed = await this.readLocalSeed();
    await this.write(seed || { ...emptyDatabase, trips: [] });
  }

  async readLocalSeed() {
    if (!this.localSeedFile) return null;
    try {
      const raw = await fs.readFile(this.localSeedFile, "utf8");
      const db = JSON.parse(raw || "{}");
      if (Array.isArray(db.trips) && db.trips.length > 0) {
        db.version = Math.max(Number(db.version || 1), emptyDatabase.version);
        db.trips.forEach(hydrateTrip);
        return db;
      }
    } catch {
      // No local seed available. This is normal on Render Free.
    }
    return null;
  }

  async fetchState({ allowMissing = false } = {}) {
    const path = `/rest/v1/${encodeURIComponent(this.tableName)}?id=eq.${encodeURIComponent(this.stateId)}&select=data&limit=1`;
    const rows = await this.client.requestJson(path, { method: "GET" });
    if (!Array.isArray(rows) || rows.length === 0) {
      if (allowMissing) return null;
      throw new HttpError(500, "Supabase 尚未建立日記資料列");
    }
    const db = rows[0]?.data || { ...emptyDatabase, trips: [] };
    if (!Array.isArray(db.trips)) db.trips = [];
    db.version = Math.max(Number(db.version || 1), emptyDatabase.version);
    db.trips.forEach(hydrateTrip);
    return db;
  }

  async read() {
    await this.ready;
    return this.fetchState();
  }

  async write(db) {
    const normalized = {
      ...db,
      version: Math.max(Number(db.version || 1), emptyDatabase.version),
      trips: Array.isArray(db.trips) ? db.trips : []
    };
    const path = `/rest/v1/${encodeURIComponent(this.tableName)}?on_conflict=id`;
    await this.client.requestJson(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        id: this.stateId,
        data: normalized,
        updated_at: new Date().toISOString()
      })
    });
  }
}

class SupabasePhotoUploader {
  constructor({ supabaseUrl, serviceRoleKey, bucket }) {
    this.client = new SupabaseRestClient({ supabaseUrl, serviceRoleKey });
    this.bucket = bucket;
  }

  async upload({ data, contentType, filename }) {
    const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_");
    const today = new Date().toISOString().slice(0, 10);
    const objectPath = `${today}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeFilename}`;
    await this.client.requestRaw(`/storage/v1/object/${encodePath(this.bucket)}/${encodePath(objectPath)}`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "x-upsert": "false"
      },
      body: data
    });
    return this.publicUrl(objectPath);
  }

  publicUrl(objectPath) {
    return `${this.client.supabaseUrl}/storage/v1/object/public/${encodePath(this.bucket)}/${encodePath(objectPath)}`;
  }
}

class SupabaseRestClient {
  constructor({ supabaseUrl, serviceRoleKey }) {
    this.supabaseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
    this.serviceRoleKey = serviceRoleKey;
    if (!this.supabaseUrl || !this.serviceRoleKey) {
      throw new Error("Supabase URL 或 Service Role Key 尚未設定");
    }
  }

  baseHeaders(extra = {}) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...extra
    };
  }

  async requestJson(pathname, options = {}) {
    const response = await this.request(pathname, {
      ...options,
      headers: this.baseHeaders(options.headers)
    });
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async requestRaw(pathname, options = {}) {
    return this.request(pathname, {
      ...options,
      headers: this.baseHeaders(options.headers)
    });
  }

  async request(pathname, options = {}) {
    const response = await fetch(`${this.supabaseUrl}${pathname}`, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = parseSupabaseError(text) || response.statusText || "Supabase request failed";
      throw new HttpError(response.status >= 400 && response.status < 500 ? 400 : 502, `Supabase 錯誤：${message}`);
    }
    return response;
  }
}

function parseSupabaseError(text) {
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    return json.message || json.error || json.msg || text;
  } catch {
    return text.slice(0, 300);
  }
}

function encodePath(pathname) {
  return String(pathname)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function normalizeActor(actor = {}) {
  const lineUserId = cleanText(actor.lineUserId || actor.userId || "guest");
  const displayName = cleanText(actor.displayName || actor.name || lineUserId);
  return {
    lineUserId,
    displayName
  };
}

export function makeSourceKey(source = {}) {
  if (source.groupId) return `group:${source.groupId}`;
  if (source.roomId) return `room:${source.roomId}`;
  if (source.userId) return `user:${source.userId}`;
  return "";
}

function hydrateTrip(trip) {
  const actor = normalizeActor(trip.owner || trip.createdBy || {});
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
  trip.members = mergeMembers(trip.members, trip.owner);
  trip.itinerary = Array.isArray(trip.itinerary)
    ? trip.itinerary.map((item) => normalizeItineraryItem(item))
    : [];
  trip.todos = Array.isArray(trip.todos) ? trip.todos.map(hydrateTodo) : [];
  trip.wishes = Array.isArray(trip.wishes) ? trip.wishes.map(hydrateWish) : [];
  return trip;
}

function hydrateMember(member) {
  const role = member.role === "owner" ? "owner" : member.role === "manual" || member.manual ? "manual" : "member";
  const normalized = normalizeActor(member);
  const ids = normalizeMemberIds(member);
  const primaryId = normalized.lineUserId && !normalized.lineUserId.startsWith("manual:") ? normalized.lineUserId : "";
  return {
    ...normalized,
    lineUserIds: ids.includes(primaryId) ? ids : [primaryId, ...ids].filter(Boolean),
    role,
    manual: Boolean(member.manual || role === "manual"),
    joinedAt: member.joinedAt || new Date().toISOString()
  };
}

function mergeMembers(members = [], owner = {}) {
  const result = [];
  const ownerId = cleanText(owner.lineUserId || owner.userId);

  for (const raw of members || []) {
    const incoming = hydrateMember(raw);
    if (ownerId && incoming.lineUserId === ownerId) {
      incoming.role = "owner";
      incoming.manual = false;
    }
    const existing = result.find((member) => membersRepresentSamePerson(member, incoming));
    if (existing) {
      mergeMemberInto(existing, incoming, ownerId);
    } else {
      result.push(incoming);
    }
  }

  if (ownerId && !result.some((member) => member.lineUserId === ownerId)) {
    result.unshift({
      ...normalizeActor(owner),
      role: "owner",
      manual: false,
      joinedAt: owner.joinedAt || new Date().toISOString()
    });
  }

  result.sort((a, b) => memberRoleRank(a) - memberRoleRank(b) || new Date(a.joinedAt) - new Date(b.joinedAt));
  return result;
}

function membersRepresentSamePerson(a = {}, b = {}) {
  const aIds = normalizeMemberIds(a);
  const bIds = normalizeMemberIds(b);
  if (aIds.some((id) => bIds.includes(id))) return true;
  // 手動新增與 LINE 加入常會先後產生兩筆同名資料；同行成員以家人顯示名稱去重。
  return sameDisplayName(a.displayName, b.displayName);
}

function normalizeMemberIds(member = {}) {
  const ids = [];
  const add = (value) => {
    const id = cleanText(value);
    if (id && !id.startsWith("manual:") && !ids.includes(id)) ids.push(id);
  };
  add(member.lineUserId || member.userId);
  if (Array.isArray(member.lineUserIds)) member.lineUserIds.forEach(add);
  return ids;
}

function sameDisplayName(a, b) {
  if (isTechnicalIdentity(a) || isTechnicalIdentity(b)) return false;
  const left = normalizeDisplayNameKey(a);
  const right = normalizeDisplayNameKey(b);
  return Boolean(left && right && left === right);
}

function normalizeDisplayNameKey(value) {
  return cleanText(value).replace(/\s+/g, "").toLowerCase();
}

function mergeMemberInto(target, incoming, ownerId = "") {
  const incomingIsReal = incoming.lineUserId && !incoming.lineUserId.startsWith("manual:");
  const targetIsManual = !target.lineUserId || target.lineUserId.startsWith("manual:") || target.manual || target.role === "manual";
  target.lineUserIds = Array.from(new Set([...normalizeMemberIds(target), ...normalizeMemberIds(incoming)]));
  if (incomingIsReal && targetIsManual) target.lineUserId = incoming.lineUserId;
  if (!isTechnicalIdentity(incoming.displayName) && (isTechnicalIdentity(target.displayName) || cleanText(incoming.displayName).length > cleanText(target.displayName).length)) {
    target.displayName = incoming.displayName;
  }
  if (target.lineUserId === ownerId || incoming.lineUserId === ownerId || target.role === "owner" || incoming.role === "owner") {
    target.role = "owner";
    target.manual = false;
  } else if (!incoming.manual && incoming.role !== "manual") {
    target.role = "member";
    target.manual = false;
  }
  if (incoming.joinedAt && (!target.joinedAt || new Date(incoming.joinedAt) < new Date(target.joinedAt))) {
    target.joinedAt = incoming.joinedAt;
  }
  return target;
}

function memberRoleRank(member = {}) {
  if (member.role === "owner") return 0;
  if (member.manual || member.role === "manual") return 2;
  return 1;
}

function hydrateWish(wish) {
  const author = normalizeActor(wish.author || wish.createdBy || {});
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
  const createdBy = normalizeActor(todo.createdBy || {});
  return normalizeTodoItem({
    ...todo,
    createdBy,
    updatedBy: normalizeActor(todo.updatedBy || createdBy),
    createdAt: todo.createdAt || new Date().toISOString(),
    updatedAt: todo.updatedAt || todo.createdAt || new Date().toISOString()
  });
}

function upgradeActorNames(trip, actor = {}) {
  const normalized = normalizeActor(actor);
  if (!normalized.lineUserId || isTechnicalIdentity(normalized.displayName)) return;
  const maybeUpgrade = (target) => {
    if (!target || target.lineUserId !== normalized.lineUserId) return;
    if (isTechnicalIdentity(target.displayName)) target.displayName = normalized.displayName;
  };
  maybeUpgrade(trip.owner);
  maybeUpgrade(trip.createdBy);
  maybeUpgrade(trip.updatedBy);
  for (const member of trip.members || []) maybeUpgrade(member);
  for (const item of trip.itinerary || []) {
    maybeUpgrade(item.createdBy);
    maybeUpgrade(item.updatedBy);
    if (item.payer === normalized.lineUserId && isTechnicalIdentity(item.payerName)) item.payerName = normalized.displayName;
  }
  for (const todo of trip.todos || []) {
    maybeUpgrade(todo.createdBy);
    maybeUpgrade(todo.updatedBy);
  }
  for (const wish of trip.wishes || []) {
    maybeUpgrade(wish.author);
    maybeUpgrade(wish.createdBy);
    maybeUpgrade(wish.updatedBy);
  }
}

function isTechnicalIdentity(value) {
  const text = cleanText(value);
  return !text || /^guest[-_]/i.test(text) || /^guest$/i.test(text) || /^line-guest$/i.test(text) || /^U[a-f0-9]{20,}$/i.test(text) || text === "LINE 使用者" || text === "尚未設定名稱";
}

function canSeeTrip(trip, { userId, sourceKey } = {}) {
  if (sourceKey && trip.sourceKeys?.includes(sourceKey)) return true;
  if (!userId) return false;
  if (trip.owner?.lineUserId === userId) return true;
  return trip.members?.some((member) => normalizeMemberIds(member).includes(userId));
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
  const inviteToken = cleanText(actor.inviteToken || actor.tripInviteToken || "");

  // The app is meant for a private family diary.  LINE/LIFF sometimes gives a
  // different guest id after browser changes, so destructive actions should
  // still work when the user is opening the diary through its own invite token.
  if (inviteToken && inviteToken === trip.inviteToken) return;

  if (!userId && !sourceKey) throw new HttpError(401, "需要 LINE 使用者身份");
  if (!canSeeTrip(trip, { userId, sourceKey })) {
    if (process.env.OPEN_DIARY_BOOK !== "false" && userId) {
      upsertMember(trip, actor, "member");
      return;
    }
    throw new HttpError(403, "你還不是這本旅行日記的編輯者");
  }
}

function upsertMember(trip, actor = {}, role = "member") {
  trip.members = Array.isArray(trip.members) ? mergeMembers(trip.members, trip.owner) : [];
  const normalized = normalizeActor(actor);
  const candidate = {
    ...normalized,
    role,
    manual: role === "manual",
    joinedAt: new Date().toISOString()
  };

  const existing = trip.members.find((member) => membersRepresentSamePerson(member, candidate));
  if (existing) {
    mergeMemberInto(existing, candidate, trip.owner?.lineUserId);
    trip.members = mergeMembers(trip.members, trip.owner);
    return trip.members.find((member) => membersRepresentSamePerson(member, existing)) || existing;
  }

  trip.members.push(candidate);
  trip.members = mergeMembers(trip.members, trip.owner);
  return trip.members.find((member) => membersRepresentSamePerson(member, candidate)) || candidate;
}

function normalizeItineraryItem(item = {}) {
  const createdBy = normalizeActor(item.createdBy || {});
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
    completed: normalizeBoolean(item.completed),
    price: normalizePrice(item.price),
    currency: cleanText(item.currency || "TWD") || "TWD",
    payer: cleanText(item.payer),
    payerName: cleanText(item.payerName || item.payer),
    splitMode: normalizeSplitMode(item.splitMode),
    customSplits: normalizeCustomSplits(item.customSplits),
    paidPeople: cleanText(item.paidPeople),
    unpaidPeople: cleanText(item.unpaidPeople),
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
  const createdBy = normalizeActor(todo.createdBy || {});
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

function normalizeSplitMode(value) {
  const allowed = new Set(["equal", "member_amounts", "payer_only", "custom"]);
  if (value === "custom") return "member_amounts";
  return allowed.has(value) ? value : "equal";
}

function normalizeCustomSplits(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      personId: cleanText(entry.personId || entry.id || entry.lineUserId || entry.displayName),
      personName: cleanText(entry.personName || entry.name || entry.displayName || entry.personId),
      amount: normalizePrice(entry.amount)
    }))
    .filter((entry) => entry.personId && entry.amount > 0);
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

function normalizeBoolean(value) {
  if (value === true) return true;
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "done", "completed", "完成", "已完成"].includes(text);
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

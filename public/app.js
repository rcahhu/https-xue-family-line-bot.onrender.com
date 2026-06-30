const state = {
  config: null,
  user: null,
  liffReady: false,
  trips: [],
  currentTrip: null,
  isCreating: false,
  activeTab: "itinerary",
  itineraryView: "list",
  editingItineraryId: "",
  showSettlement: false,
  deferredInstallPrompt: null,
  recommendations: null,
  recommendationTripId: null
};

const KNOWN_INVITES_KEY = "xue-family-known-trip-invites";
const DISPLAY_NAME_KEY = "xue-family-display-name";
const DISPLAY_NAME_KEY_PREFIX = "xue-family-display-name:";

const els = {
  userBadge: document.querySelector("#userBadge"),
  inviteButton: document.querySelector("#inviteButton"),
  tripInviteButton: document.querySelector("#tripInviteButton"),
  deleteTripButton: document.querySelector("#deleteTripButton"),
  createTripForm: document.querySelector("#createTripForm"),
  newDiaryView: document.querySelector("#newDiaryView"),
  tripTitleInput: document.querySelector("#tripTitleInput"),
  tripAreaInput: document.querySelector("#tripAreaInput"),
  tripStartDateInput: document.querySelector("#tripStartDateInput"),
  tripEndDateInput: document.querySelector("#tripEndDateInput"),
  tripNoteInput: document.querySelector("#tripNoteInput"),
  tripCoverPhotoInput: document.querySelector("#tripCoverPhotoInput"),
  tripList: document.querySelector("#tripList"),
  backToDiaryListButton: document.querySelector("#backToDiaryListButton"),
  emptyState: document.querySelector("#emptyState"),
  tripView: document.querySelector("#tripView"),
  tripSettingsForm: document.querySelector("#tripSettingsForm"),
  currentTripTitle: document.querySelector("#currentTripTitle"),
  currentTripArea: document.querySelector("#currentTripArea"),
  currentTripPeople: document.querySelector("#currentTripPeople"),
  currentTripStyle: document.querySelector("#currentTripStyle"),
  currentTripLodging: document.querySelector("#currentTripLodging"),
  currentTripCoverPhoto: document.querySelector("#currentTripCoverPhoto"),
  tripHeroTitle: document.querySelector("#tripHeroTitle"),
  tripHeroMeta: document.querySelector("#tripHeroMeta"),
  tripHero: document.querySelector(".trip-hero"),
  tripStats: document.querySelector("#tripStats"),
  tabs: document.querySelector(".tabs"),
  itineraryPanel: document.querySelector("#itineraryPanel"),
  todosPanel: document.querySelector("#todosPanel"),
  wishesPanel: document.querySelector("#wishesPanel"),
  recommendationsPanel: document.querySelector("#recommendationsPanel"),
  membersPanel: document.querySelector("#membersPanel"),
  quickAddButton: document.querySelector("#quickAddButton"),
  shortcutModal: document.querySelector("#shortcutModal"),
  shortcutUrlInput: document.querySelector("#shortcutUrlInput"),
  toast: document.querySelector("#toast")
};

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  showError(event.reason || new Error("操作失敗"));
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
});

init().catch(showError);

async function init() {
  registerServiceWorker();
  bindEvents();
  state.config = await api("/api/config");
  state.user = await resolveUser();
  await ensureDisplayName();
  renderUser();

  const params = new URLSearchParams(location.search);
  const tripId = params.get("trip");
  const inviteToken = params.get("invite");
  state.isCreating = params.has("new");

  if (tripId && inviteToken) {
    rememberInvite(tripId, inviteToken);
    await joinTripFromInvite(tripId, inviteToken);
  }

  await loadTrips();

  if (tripId) await selectTrip(tripId, inviteToken);
  else render();
}

function bindEvents() {
  els.userBadge.addEventListener("click", () => {
    ensureDisplayName({ force: true }).catch(showError);
  });

  els.createTripForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = els.tripTitleInput.value.trim();
    const area = els.tripAreaInput.value.trim() || title;
    if (!title) return;

    const coverPhotoUrl = await uploadImageFile(els.tripCoverPhotoInput);
    const { trip } = await api("/api/trips", {
      method: "POST",
      body: {
        title,
        area,
        startDate: els.tripStartDateInput.value,
        endDate: els.tripEndDateInput.value,
        note: els.tripNoteInput.value.trim(),
        coverPhotoUrl,
        actor: state.user
      }
    });

    rememberInvite(trip.id, trip.inviteToken);
    els.createTripForm.reset();
    renderNewDiaryCoverPreview();
    state.isCreating = false;
    await loadTrips();
    await selectTrip(trip.id);
    toast(`已建立「${trip.title}」`);
  });

  els.tripCoverPhotoInput.addEventListener("change", renderNewDiaryCoverPreview);

  els.tripList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-trip-id]");
    if (!button) return;
    await selectTrip(button.dataset.tripId);
  });

  els.backToDiaryListButton.addEventListener("click", () => {
    state.currentTrip = null;
    state.isCreating = false;
    state.activeTab = "itinerary";
    state.itineraryView = "list";
    state.editingItineraryId = "";
    history.replaceState(null, "", "/app");
    updateManifestLink();
    render();
  });

  els.tripSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const patch = {
      title: els.currentTripTitle.value.trim(),
      area: els.currentTripArea.value.trim(),
      peopleCount: els.currentTripPeople.value.trim(),
      stylePreference: els.currentTripStyle.value.trim(),
      lodgingPreference: els.currentTripLodging.value.trim()
    };
    const coverPhotoUrl = await uploadImageFile(els.currentTripCoverPhoto);
    if (coverPhotoUrl) patch.coverPhotoUrl = coverPhotoUrl;
    await api(`/api/trips/${state.currentTrip.id}`, {
      method: "PATCH",
      body: accessPayload({ patch })
    });
    await refreshCurrentTrip();
    await loadTrips();
    await loadRecommendations(true);
    toast("日記已儲存");
  });

  els.deleteTripButton.addEventListener("click", async () => {
    if (!state.currentTrip) return;
    const confirmed = window.confirm(
      `確定要刪除「${state.currentTrip.title}」嗎？這本日記裡的行程、住宿、搭車和許願都會一起刪除。`
    );
    if (!confirmed) return;

    const deletedTripId = state.currentTrip.id;
    await api(`/api/trips/${deletedTripId}`, {
      method: "DELETE",
      body: accessPayload()
    });
    forgetInvite(deletedTripId);
    state.trips = state.trips.filter((trip) => trip.id !== deletedTripId);
    state.currentTrip = null;
    await loadTrips();
    history.replaceState(null, "", "/app");
    render();
    toast("日記已刪除");
  });

  els.tabs.addEventListener("click", (event) => {
    const shortcutButton = event.target.closest("[data-trip-shortcut]");
    if (shortcutButton) {
      openShortcutModal();
      return;
    }

    const settlementButton = event.target.closest("[data-toggle-settlement]");
    if (settlementButton) {
      toggleSettlementFromTop();
      return;
    }

    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    state.activeTab = tab.dataset.tab;
    renderPanels();
  });

  els.inviteButton.addEventListener("click", () => inviteCurrentTrip().catch(showError));
  els.tripInviteButton.addEventListener("click", () => inviteCurrentTrip().catch(showError));
  els.quickAddButton.addEventListener("click", () => {
    if (!state.currentTrip) return;
    openItineraryCreateView();
  });

  els.membersPanel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-invite-current]");
    if (!button) return;
    inviteCurrentTrip().catch(showError);
  });

  els.membersPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".manual-member-form")) return;
    event.preventDefault();
    const form = event.target;
    const displayName = String(new FormData(form).get("displayName") || "").trim();
    if (!displayName) {
      toast("請輸入同行成員名稱");
      return;
    }
    await api(`/api/trips/${state.currentTrip.id}/members`, {
      method: "POST",
      body: accessPayload({ member: { displayName } })
    });
    form.reset();
    await refreshCurrentTrip();
    toast("已加入同行成員");
  });

  els.itineraryPanel.addEventListener("submit", async (event) => {
    if (event.target.matches(".item-form")) {
      event.preventDefault();
      const item = await formObject(event.target);
      await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
        method: "POST",
        body: accessPayload({ item })
      });
      state.itineraryView = "list";
      state.editingItineraryId = "";
      await refreshCurrentTrip();
      toast("行程已新增");
      return;
    }

    if (event.target.matches(".item-edit-form")) {
      event.preventDefault();
      const itemId = event.target.dataset.itemId;
      const patch = await formObject(event.target);
      await api(`/api/trips/${state.currentTrip.id}/itinerary/${itemId}`, {
        method: "PATCH",
        body: accessPayload({ patch })
      });
      state.itineraryView = "list";
      state.editingItineraryId = "";
      await refreshCurrentTrip();
      toast("行程已修改");
    }
  });

  els.itineraryPanel.addEventListener("change", (event) => {
    const completedToggle = event.target.closest("[data-item-completed]");
    if (completedToggle) {
      updateItineraryCompleted(completedToggle).catch(showError);
      return;
    }

    const typeSelect = event.target.closest(".item-type-select");
    if (typeSelect) syncTypeFields(typeSelect.form);

    const splitSelect = event.target.closest("select[name='splitMode']");
    if (splitSelect) syncSplitFields(splitSelect.form);
  });

  els.itineraryPanel.addEventListener("click", async (event) => {
    const newButton = event.target.closest("[data-itinerary-new]");
    if (newButton) {
      openItineraryCreateView();
      return;
    }

    const settlementButton = event.target.closest("[data-toggle-settlement]");
    if (settlementButton) {
      state.showSettlement = !state.showSettlement;
      renderItinerary();
      if (state.showSettlement) {
        window.setTimeout(() => document.querySelector(".settlement-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
      return;
    }

    const backButton = event.target.closest("[data-itinerary-back]");
    if (backButton) {
      openItineraryListView();
      return;
    }

    const editButton = event.target.closest("[data-edit-toggle]");
    if (editButton) {
      openItineraryEditView(editButton.dataset.editToggle);
      return;
    }

    const button = event.target.closest("[data-delete-item]");
    if (!button) return;
    if (!window.confirm("確定刪除這筆行程嗎？")) return;
    await api(`/api/trips/${state.currentTrip.id}/itinerary/${button.dataset.deleteItem}`, {
      method: "DELETE",
      body: accessPayload()
    });
    state.itineraryView = "list";
    state.editingItineraryId = "";
    if (state.currentTrip?.itinerary) {
      state.currentTrip.itinerary = state.currentTrip.itinerary.filter((item) => item.id !== button.dataset.deleteItem);
      renderPanels();
    }
    await refreshCurrentTrip();
    toast("行程已刪除");
  });

  els.todosPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".todo-form")) return;
    event.preventDefault();
    const todo = await formObject(event.target);
    await api(`/api/trips/${state.currentTrip.id}/todos`, {
      method: "POST",
      body: accessPayload({ todo })
    });
    event.target.reset();
    await refreshCurrentTrip();
    toast("待辦已新增");
  });

  els.todosPanel.addEventListener("change", async (event) => {
    const target = event.target.closest("[data-todo-field]");
    if (!target) return;
    await api(`/api/trips/${state.currentTrip.id}/todos/${target.dataset.todoId}`, {
      method: "PATCH",
      body: {
        ...accessPayload(),
        patch: { [target.dataset.todoField]: target.value }
      }
    });
    await refreshCurrentTrip();
  });

  els.todosPanel.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-todo]");
    if (!button) return;
    if (!window.confirm("確定刪除這個待辦嗎？")) return;
    await api(`/api/trips/${state.currentTrip.id}/todos/${button.dataset.deleteTodo}`, {
      method: "DELETE",
      body: accessPayload()
    });
    if (state.currentTrip?.todos) {
      state.currentTrip.todos = state.currentTrip.todos.filter((todo) => todo.id !== button.dataset.deleteTodo);
      renderPanels();
    }
    await refreshCurrentTrip();
    toast("待辦已刪除");
  });

  els.wishesPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".wish-form")) return;
    event.preventDefault();
    const wish = await formObject(event.target);
    await api(`/api/trips/${state.currentTrip.id}/wishes`, {
      method: "POST",
      body: accessPayload({ wish })
    });
    event.target.reset();
    await refreshCurrentTrip();
    toast("願望已加入");
  });

  els.wishesPanel.addEventListener("change", async (event) => {
    const target = event.target.closest("[data-wish-field]");
    if (!target) return;
    await api(`/api/trips/${state.currentTrip.id}/wishes/${target.dataset.wishId}`, {
      method: "PATCH",
      body: {
        ...accessPayload(),
        patch: { [target.dataset.wishField]: target.value }
      }
    });
    await refreshCurrentTrip();
  });

  els.wishesPanel.addEventListener("click", async (event) => {
    const addButton = event.target.closest("[data-add-wish-itinerary]");
    if (addButton) {
      await addWishToItinerary(addButton.dataset.addWishItinerary);
      return;
    }

    const button = event.target.closest("[data-delete-wish]");
    if (!button) return;
    if (!window.confirm("確定刪除這個願望嗎？")) return;
    await api(`/api/trips/${state.currentTrip.id}/wishes/${button.dataset.deleteWish}`, {
      method: "DELETE",
      body: accessPayload()
    });
    if (state.currentTrip?.wishes) {
      state.currentTrip.wishes = state.currentTrip.wishes.filter((wish) => wish.id !== button.dataset.deleteWish);
      renderPanels();
    }
    await refreshCurrentTrip();
    toast("願望已刪除");
  });

  els.recommendationsPanel.addEventListener("click", async (event) => {
    const locationButton = event.target.closest("[data-use-location]");
    if (locationButton) {
      await loadRecommendationsFromLocation();
      return;
    }

    const button = event.target.closest("[data-add-recommendation]");
    if (!button) return;
    await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
      method: "POST",
      body: {
        ...accessPayload(),
        item: {
          type: "activity",
          title: button.dataset.name,
          place: button.dataset.area,
          note: button.dataset.note,
          ticketStatus: "none",
          reservationStatus: "none",
          price: 0
        }
      }
    });
    await refreshCurrentTrip();
    state.activeTab = "itinerary";
    renderPanels();
    toast("已加入行程");
  });

  document.body.addEventListener("click", (event) => {
    const shortcutButton = event.target.closest("[data-trip-shortcut]");
    if (shortcutButton) {
      openShortcutModal();
      return;
    }

    const shortcutClose = event.target.closest("[data-shortcut-close]");
    if (shortcutClose || event.target === els.shortcutModal) {
      closeShortcutModal();
      return;
    }

    const shortcutInstall = event.target.closest("[data-shortcut-install]");
    if (shortcutInstall) {
      installTripShortcut().catch(showError);
      return;
    }

    const shortcutExternal = event.target.closest("[data-shortcut-external]");
    if (shortcutExternal) {
      openExternalLink(tripShortcutUrl());
      return;
    }

    const shortcutCopy = event.target.closest("[data-shortcut-copy]");
    if (shortcutCopy) {
      copyShortcutUrl().catch(showError);
      return;
    }

    const externalLink = event.target.closest("a[data-external-link]");
    if (externalLink) {
      event.preventDefault();
      openExternalLink(externalLink.href);
      return;
    }

    const closeButton = event.target.closest("[data-photo-close]");
    const viewer = document.querySelector("#photoViewer");
    if (closeButton || event.target === viewer) {
      closePhotoViewer();
      return;
    }

    const photoButton = event.target.closest("[data-photo-open]");
    if (!photoButton) return;
    openPhotoViewer(photoButton.dataset.photoOpen);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePhotoViewer();
  });

}

async function resolveUser() {
  const fallback = guestUser();
  if (!state.config?.liffId || !window.liff) return fallback;

  try {
    await window.liff.init({ liffId: state.config.liffId });
    state.liffReady = true;
    if (!window.liff.isLoggedIn()) {
      if (window.liff.isInClient()) window.liff.login({ redirectUri: location.href });
      return fallback;
    }
    const profile = await window.liff.getProfile();
    const lineDisplayName = cleanDisplayName(profile.displayName);
    return {
      lineUserId: profile.userId,
      displayName: savedDisplayName(profile.userId) || lineDisplayName,
      lineDisplayName,
      pictureUrl: profile.pictureUrl || "",
      isLineUser: true
    };
  } catch (error) {
    console.warn("LIFF init failed, using guest mode.", error);
    return fallback;
  }
}

function guestUser() {
  const key = "xue-family-guest-id";
  let id = "";
  try {
    id = localStorage.getItem(key) || "";
    if (!id) {
      id = `guest-${cryptoRandom()}`;
      localStorage.setItem(key, id);
    }
  } catch {
    id = `guest-${cryptoRandom()}`;
  }
  return {
    lineUserId: id,
    displayName: savedDisplayName(id) || "",
    isGuest: true
  };
}

async function ensureDisplayName({ force = false } = {}) {
  const currentName = userDisplayName(state.user);
  if (!force && currentName) return currentName;

  const nextName = await promptDisplayName({
    initialValue: currentName || state.user?.lineDisplayName || "",
    canCancel: force && Boolean(currentName)
  });
  if (!nextName) return currentName;

  state.user.displayName = nextName;
  saveDisplayName(nextName, state.user?.lineUserId);
  renderUser();

  if (state.currentTrip) {
    try {
      await api(`/api/trips/${state.currentTrip.id}`, {
        method: "PATCH",
        body: accessPayload({ patch: {} })
      });
      await refreshCurrentTrip();
    } catch (error) {
      console.warn("Display name sync failed.", error);
    }
  }
  return nextName;
}

function promptDisplayName({ initialValue = "", canCancel = false } = {}) {
  return new Promise((resolve) => {
    document.querySelector(".identity-dialog-backdrop")?.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "identity-dialog-backdrop";
    const lineName = cleanDisplayName(state.user?.lineDisplayName || "");
    wrapper.innerHTML = `
      <form class="identity-dialog" autocomplete="off">
        <div>
          <p class="eyebrow">加入日記本</p>
          <h2>設定顯示名稱</h2>
          <p class="muted">這個名字會顯示在建立者、最後編輯、付款人與編輯者紀錄裡。</p>
          ${lineName ? `<p class="name-hint">已從 LINE 取得：<strong>${escapeHtml(lineName)}</strong>，可以直接使用，也可以改成家人習慣稱呼。</p>` : `<p class="name-hint">目前沒有取得 LINE 暱稱，請先設定一個家人看得懂的名字。</p>`}
        </div>
        <label>
          我的顯示名稱
          <input name="displayName" maxlength="24" placeholder="例如：小慈、媽媽、爸爸、阿嬤" value="${escapeAttr(initialValue)}" required />
        </label>
        <div class="identity-actions">
          ${canCancel ? `<button class="plain-button" type="button" data-name-cancel>取消</button>` : ""}
          <button class="primary-button" type="submit">儲存並繼續</button>
        </div>
      </form>
    `;
    document.body.appendChild(wrapper);
    const form = wrapper.querySelector("form");
    const input = wrapper.querySelector("input[name='displayName']");
    input.focus();
    input.select();

    wrapper.querySelector("[data-name-cancel]")?.addEventListener("click", () => {
      wrapper.remove();
      resolve("");
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = cleanDisplayName(input.value);
      if (!name) {
        input.focus();
        toast("請先輸入顯示名稱");
        return;
      }
      wrapper.remove();
      resolve(name);
    });
  });
}

function cleanDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function displayNameStorageKeys(userId = state.user?.lineUserId) {
  const keys = [];
  const id = String(userId || "").trim();
  if (id) keys.push(`${DISPLAY_NAME_KEY_PREFIX}${id}`);
  keys.push(DISPLAY_NAME_KEY);
  return keys;
}

function savedDisplayName(userId) {
  try {
    for (const key of displayNameStorageKeys(userId)) {
      const value = cleanDisplayName(localStorage.getItem(key) || "");
      if (value && !isTechnicalIdentity(value)) return value;
    }
  } catch {
    // localStorage may be unavailable in some restricted in-app browsers.
  }
  return "";
}

function saveDisplayName(name, userId) {
  const value = cleanDisplayName(name);
  if (!value) return;
  try {
    for (const key of displayNameStorageKeys(userId)) localStorage.setItem(key, value);
  } catch {
    // localStorage may be unavailable in some restricted in-app browsers.
  }
}

function userDisplayName(user = state.user) {
  const name = cleanDisplayName(user?.displayName || user?.name || "");
  if (name && !isTechnicalIdentity(name)) return name;
  const lineName = cleanDisplayName(user?.lineDisplayName || "");
  if (lineName && !isTechnicalIdentity(lineName)) return lineName;
  return "";
}

function isTechnicalIdentity(value) {
  const text = String(value || "").trim();
  return !text || /^guest[-_]/i.test(text) || /^guest$/i.test(text) || /^line-guest$/i.test(text) || /^U[a-f0-9]{20,}$/i.test(text);
}

async function joinTripFromInvite(tripId, inviteToken) {
  try {
    const { trip } = await api(`/api/trips/${tripId}/join`, {
      method: "POST",
      body: accessPayload({ inviteToken })
    });
    rememberInvite(tripId, inviteToken);
    state.currentTrip = trip;
    toast(`已加入「${trip.title}」`);
  } catch (error) {
    console.warn(error);
  }
}

async function loadTrips() {
  const params = new URLSearchParams({
    userId: state.user.lineUserId,
    includeAll: "1"
  });
  const invites = knownInviteParam();
  if (invites) params.set("invites", invites);
  const { trips } = await api(`/api/trips?${params}`);
  trips.forEach((trip) => rememberInvite(trip.id, trip.inviteToken));
  state.trips = trips;
  renderTripList();
}

async function selectTrip(tripId, inviteToken = "") {
  const params = new URLSearchParams({
    userId: state.user.lineUserId,
    displayName: state.user.displayName
  });
  params.set("allowPublic", "1");
  if (inviteToken) params.set("invite", inviteToken);
  const { trip } = await api(`/api/trips/${tripId}?${params}`);
  if (inviteToken) rememberInvite(tripId, inviteToken);
  state.isCreating = false;
  state.currentTrip = trip;
  state.itineraryView = "list";
  state.editingItineraryId = "";
  await loadRecommendations(true);
  render();
  history.replaceState(null, "", `/app?trip=${trip.id}`);
}

async function refreshCurrentTrip() {
  if (!state.currentTrip) return;
  const params = new URLSearchParams({
    userId: state.user.lineUserId,
    displayName: state.user.displayName
  });
  params.set("allowPublic", "1");
  const { trip } = await api(`/api/trips/${state.currentTrip.id}?${params}`);
  state.currentTrip = trip;
  render();
}

async function updateItineraryCompleted(toggle) {
  if (!state.currentTrip || !toggle?.dataset?.itemId) return;
  toggle.disabled = true;
  const completed = toggle.checked;
  try {
    await api(`/api/trips/${state.currentTrip.id}/itinerary/${toggle.dataset.itemId}`, {
      method: "PATCH",
      body: accessPayload({ patch: { completed } })
    });
    await refreshCurrentTrip();
    toast(completed ? "已標記完成" : "已改回未完成");
  } catch (error) {
    toggle.checked = !completed;
    throw error;
  } finally {
    toggle.disabled = false;
  }
}

async function addWishToItinerary(wishId) {
  if (!state.currentTrip || !wishId) return;
  const wish = state.currentTrip.wishes.find((entry) => entry.id === wishId);
  if (!wish) return;

  await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
    method: "POST",
    body: accessPayload({ item: wishToItineraryItem(wish) })
  });

  await api(`/api/trips/${state.currentTrip.id}/wishes/${wish.id}`, {
    method: "PATCH",
    body: accessPayload({ patch: { status: "planned" } })
  });

  await refreshCurrentTrip();
  state.activeTab = "itinerary";
  state.itineraryView = "list";
  render();
  toast("已加入行程，日期時間可以再手動補上");
}

function wishToItineraryItem(wish = {}) {
  const typeLabel = wishTypeLabel(wish.type);
  return {
    type: "activity",
    title: wish.text || "未命名願望",
    place: "",
    date: "",
    time: "",
    note: `由許願加入：${typeLabel}`,
    ticketStatus: "none",
    reservationStatus: "none",
    completed: false,
    price: 0,
    currency: "TWD",
    splitMode: "equal"
  };
}

async function loadRecommendations(force = false, coords = {}) {
  if (!state.currentTrip) return;
  if (!force && state.recommendationTripId === state.currentTrip.id && state.recommendations) return;
  const params = new URLSearchParams({
    userId: state.user.lineUserId,
    area: state.currentTrip.area
  });
  if (coords.lat && coords.lng) {
    params.set("lat", coords.lat);
    params.set("lng", coords.lng);
  }
  const { recommendations } = await api(
    `/api/trips/${state.currentTrip.id}/recommendations?${params}`
  );
  state.recommendations = recommendations;
  state.recommendationTripId = state.currentTrip.id;
}

async function loadRecommendationsFromLocation() {
  if (!navigator.geolocation) {
    toast("這台裝置不支援定位，先用日記地區推薦");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      await loadRecommendations(true, {
        lat: String(position.coords.latitude),
        lng: String(position.coords.longitude)
      });
      renderRecommendations();
      toast("已更新目的地推薦");
    },
    () => toast("無法取得定位，先用日記地區推薦")
  );
}

function render() {
  renderUser();
  renderTripList();
  const hasTrip = Boolean(state.currentTrip);
  const isCreating = Boolean(state.isCreating);
  updateScreenModeClasses(hasTrip, isCreating);
  els.newDiaryView.hidden = !isCreating;
  els.emptyState.hidden = hasTrip || isCreating;
  els.tripView.hidden = !hasTrip || isCreating;
  els.inviteButton.disabled = !hasTrip;
  els.tripInviteButton.disabled = !hasTrip;
  els.quickAddButton.hidden = !hasTrip || isCreating;
  updateManifestLink();
  if (!hasTrip || isCreating) return;

  els.currentTripTitle.value = state.currentTrip.title;
  els.currentTripArea.value = state.currentTrip.area;
  els.currentTripPeople.value = state.currentTrip.peopleCount || "";
  els.currentTripStyle.value = state.currentTrip.stylePreference || "";
  els.currentTripLodging.value = state.currentTrip.lodgingPreference || "";
  els.currentTripCoverPhoto.value = "";
  els.tripHeroTitle.textContent = state.currentTrip.title;
  els.tripHeroMeta.textContent = tripMeta(state.currentTrip);
  renderCoverPhoto();
  renderStats();
  renderItinerary();
  renderTodos();
  renderWishes();
  renderMembers();
  renderPanels();
}

function updateScreenModeClasses(hasTrip = Boolean(state.currentTrip), isCreating = Boolean(state.isCreating)) {
  const isItineraryForm =
    hasTrip && !isCreating && ["new", "edit"].includes(state.itineraryView || "list");
  document.body.classList.toggle("has-trip", hasTrip);
  document.body.classList.toggle("no-trip", !hasTrip && !isCreating);
  document.body.classList.toggle("is-creating", isCreating);
  document.body.classList.toggle("itinerary-form-mode", isItineraryForm);
}

function renderUser() {
  const name = userDisplayName(state.user);
  els.userBadge.textContent = name ? `編輯：${name}` : "設定顯示名稱";
  els.userBadge.title = "點一下可以修改顯示名稱";
  els.userBadge.classList.toggle("needs-name", !name);
}

function renderTripList() {
  if (!state.trips.length) {
    els.tripList.innerHTML = `<p class="muted">還沒有日記</p>`;
    return;
  }
  els.tripList.innerHTML = state.trips
    .map((trip, index) => {
      const coverStyle = trip.coverPhotoUrl
        ? ` style="background-image: url('${escapeAttr(cssUrl(trip.coverPhotoUrl))}')"`
        : "";
      return `
        <button class="trip-link cover-${index % 4} ${state.currentTrip?.id === trip.id ? "is-active" : ""} ${trip.coverPhotoUrl ? "has-cover-photo" : ""}" type="button" data-trip-id="${escapeAttr(trip.id)}">
          <span class="trip-cover"${coverStyle} aria-label="${escapeAttr(trip.title)}封面"></span>
          <strong class="trip-list-title">${escapeHtml(trip.title)}</strong>
          <span>${escapeHtml(tripMeta(trip))}</span>
        </button>
      `;
    })
    .join("");
}

function renderStats() {
  const trip = state.currentTrip;
  const costTotal = totalItineraryCost(trip.itinerary || []);
  const transportCount = trip.itinerary.filter((item) => item.type === "transport").length;
  const lodgingCount = trip.itinerary.filter((item) => item.type === "lodging").length;
  const completedCount = trip.itinerary.filter((item) => item.completed).length;
  const openTodoCount = trip.todos.filter((todo) => !["done", "not_needed"].includes(todo.status)).length;
  els.tripStats.innerHTML = [
    stat("行程花費", money(costTotal.amount, costTotal.currency)),
    stat("行程", `${trip.itinerary.length} 筆`),
    stat("已完成", `${completedCount}/${trip.itinerary.length || 0}`),
    stat("待辦缺口", `${openTodoCount} 個`),
    stat("搭車", `${transportCount} 筆`),
    stat("住宿", `${lodgingCount} 筆`),
    stat("同行人數", trip.peopleCount || "未填"),
    stat("建立者", actorName(trip.createdBy)),
    stat("最後編輯", `${actorName(trip.updatedBy)} · ${formatDateTime(trip.updatedAt)}`)
  ].join("");
}

function renderCoverPhoto() {
  const url = state.currentTrip?.coverPhotoUrl || "";
  els.tripHero.classList.toggle("has-cover-photo", Boolean(url));
  els.tripHero.style.backgroundImage = url
    ? `linear-gradient(180deg, rgba(29, 72, 55, 0.1), rgba(29, 72, 55, 0.72)), url("${cssUrl(url)}")`
    : "";
}

function renderNewDiaryCoverPreview() {
  const hero = document.querySelector(".new-diary-hero");
  if (!hero) return;
  const file = els.tripCoverPhotoInput.files?.[0];
  const url = file ? URL.createObjectURL(file) : "";
  hero.classList.toggle("has-cover-photo", Boolean(url));
  hero.style.backgroundImage = url
    ? `linear-gradient(180deg, rgba(29, 72, 55, 0.16), rgba(29, 72, 55, 0.72)), url("${url}")`
    : "";
}

function tripMeta(trip) {
  const dates = trip.startDate || trip.endDate ? `${trip.startDate || "未定"} 到 ${trip.endDate || "未定"}` : trip.area;
  const people = trip.peopleCount ? `同行 ${trip.peopleCount}` : "同行人數未填";
  return `${dates} · ${trip.itinerary.length} 筆行程 · ${people}`;
}

function renderItinerary() {
  updateScreenModeClasses();
  const trip = state.currentTrip;
  const view = state.itineraryView || "list";

  if (view === "new") {
    els.itineraryPanel.innerHTML = `
      <section class="itinerary-screen itinerary-form-screen">
        <div class="screen-topbar">
          <button class="plain-button" type="button" data-itinerary-back>← 回行程</button>
          <div>
            <p class="eyebrow">新增行程</p>
            <h3>新增一筆旅遊項目</h3>
            <p class="muted">像記帳 App 一樣單獨進入新增頁，填完儲存後會回到行程清單。</p>
          </div>
        </div>
        <form class="item-form screen-form">
          ${itineraryFields()}
          <div class="form-action-row full">
            <button class="plain-button" type="button" data-itinerary-back>取消</button>
            <button class="primary-button" type="submit">新增行程</button>
          </div>
        </form>
      </section>
    `;
    els.itineraryPanel.querySelectorAll(".item-form").forEach((form) => { syncTypeFields(form); syncSplitFields(form); });
    window.setTimeout(() => els.itineraryPanel.querySelector("input[name='title']")?.focus(), 120);
    return;
  }

  if (view === "edit") {
    const item = trip.itinerary.find((entry) => entry.id === state.editingItineraryId);
    if (!item) {
      state.itineraryView = "list";
      state.editingItineraryId = "";
      return renderItinerary();
    }

    els.itineraryPanel.innerHTML = `
      <section class="itinerary-screen itinerary-form-screen">
        <div class="screen-topbar">
          <button class="plain-button" type="button" data-itinerary-back>← 回行程</button>
          <div>
            <p class="eyebrow">修改行程</p>
            <h3>${escapeHtml(item.title || "這筆行程")}</h3>
            <p class="muted">目前正在修改單一行程，儲存後會回到行程清單。</p>
          </div>
        </div>
        <form class="item-edit-form screen-form" data-item-id="${escapeAttr(item.id)}">
          ${itineraryFields(item)}
          <div class="form-action-row full">
            <button class="plain-button" type="button" data-itinerary-back>取消</button>
            <button class="primary-button" type="submit">儲存修改</button>
          </div>
        </form>
      </section>
    `;
    els.itineraryPanel.querySelectorAll(".item-edit-form").forEach((form) => { syncTypeFields(form); syncSplitFields(form); });
    return;
  }

  const rows = trip.itinerary.length
    ? groupedItineraryRows(trip.itinerary)
    : `<p class="muted empty-itinerary-note">還沒有行程。按「新增行程」建立第一筆。</p>`;

  els.itineraryPanel.innerHTML = `
    <section class="itinerary-screen itinerary-list-screen">
      <div class="itinerary-list-head">
        <div>
          <p class="eyebrow">行程清單</p>
          <h3>瀏覽行程</h3>
          <p class="muted">每一筆可標記是否已完成，也可以進入單獨畫面修改。</p>
        </div>
        <div class="itinerary-head-actions">
          <button class="primary-button" type="button" data-itinerary-new>＋ 新增行程</button>
        </div>
      </div>
      ${state.showSettlement ? settlementCard(trip) : ""}
      <div class="row-list">${rows}</div>
    </section>
  `;
}

function openItineraryCreateView() {
  state.activeTab = "itinerary";
  state.itineraryView = "new";
  state.editingItineraryId = "";
  updateScreenModeClasses();
  renderPanels();
  renderItinerary();
  window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
}

function openItineraryEditView(itemId) {
  state.activeTab = "itinerary";
  state.itineraryView = "edit";
  state.editingItineraryId = itemId || "";
  updateScreenModeClasses();
  renderPanels();
  renderItinerary();
  window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
}

function openItineraryListView() {
  state.activeTab = "itinerary";
  state.itineraryView = "list";
  state.editingItineraryId = "";
  updateScreenModeClasses();
  renderPanels();
  renderItinerary();
  window.setTimeout(() => els.itineraryPanel.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function toggleSettlementFromTop() {
  const isAlreadyShowing = state.activeTab === "itinerary" && state.itineraryView === "list" && state.showSettlement;
  state.activeTab = "itinerary";
  state.itineraryView = "list";
  state.editingItineraryId = "";
  state.showSettlement = !isAlreadyShowing;
  updateScreenModeClasses();
  renderPanels();
  renderItinerary();
  updateSettlementButtons();
  if (state.showSettlement) {
    window.setTimeout(() => document.querySelector(".settlement-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
}

function updateSettlementButtons() {
  document.querySelectorAll("[data-toggle-settlement]").forEach((button) => {
    if (button.classList.contains("settlement-tab-action")) {
      button.innerHTML = state.showSettlement ? "收起<br />結算" : "結算";
      button.classList.toggle("is-active", state.activeTab === "itinerary" && state.showSettlement);
    } else {
      button.textContent = state.showSettlement ? "收起結算" : "結算";
    }
  });
}

function settlementCard(trip = state.currentTrip) {
  const summaries = buildSettlementSummary(trip);
  return `
    <section class="settlement-card">
      <div class="settlement-head">
        <div>
          <p class="eyebrow">結算</p>
          <h3>自動算誰該付誰</h3>
          <p class="muted">會抓每筆行程的「誰先付」與分帳方式；不同幣別會分開結算。</p>
        </div>
      </div>
      ${summaries.length ? summaries.map(settlementCurrencyBlock).join("") : `<p class="muted">目前沒有需要結算的花費。</p>`}
    </section>
  `;
}

function settlementCurrencyBlock(summary) {
  const ledgers = summary.ledgers.length
    ? summary.ledgers.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(money(entry.paid, summary.currency))}</td>
        <td>${escapeHtml(money(entry.owes, summary.currency))}</td>
        <td>${escapeHtml(money(entry.net, summary.currency))}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4">沒有可結算資料</td></tr>`;
  const transfers = summary.transfers.length
    ? summary.transfers.map((entry) => `<li><strong>${escapeHtml(entry.from)}</strong> 付給 <strong>${escapeHtml(entry.to)}</strong> ${escapeHtml(money(entry.amount, summary.currency))}</li>`).join("")
    : `<li>目前不用互相轉帳。</li>`;
  const notes = summary.notes.length ? `<p class="settlement-note">${escapeHtml(summary.notes.join("；"))}</p>` : "";
  return `
    <div class="settlement-currency-block">
      <h4>${escapeHtml(summary.currency)}</h4>
      <div class="settlement-table-wrap">
        <table class="settlement-table">
          <thead><tr><th>成員</th><th>已先付</th><th>應負擔</th><th>結餘</th></tr></thead>
          <tbody>${ledgers}</tbody>
        </table>
      </div>
      <div class="settlement-transfer-box">
        <strong>建議付款</strong>
        <ul>${transfers}</ul>
      </div>
      ${notes}
    </div>
  `;
}

function buildSettlementSummary(trip = state.currentTrip) {
  const byCurrency = new Map();
  for (const item of trip?.itinerary || []) {
    const amount = Number(item.price || 0);
    if (!amount || item.splitMode === "payer_only") continue;
    const currency = item.currency || "TWD";
    if (!byCurrency.has(currency)) byCurrency.set(currency, { currency, ledgers: new Map(), notes: [], equalTotal: 0 });
    const group = byCurrency.get(currency);
    const payer = participantEntryById(item.payer) || { id: item.payer || item.payerName || "payer", name: item.payerName || participantNameById(item.payer) || "先付款者" };
    const payerLedger = ledgerFor(group.ledgers, payer.id, payer.name);
    payerLedger.paid += amount;

    if (item.splitMode === "member_amounts") {
      const shares = customSharesForSettlement(item);
      const total = shares.reduce((sum, share) => sum + share.amount, 0);
      if (Math.round(total) !== Math.round(amount)) {
        group.notes.push(`${item.title || "某筆行程"} 的成員分帳合計 ${money(total, currency)}，與行程金額 ${money(amount, currency)} 不同`);
      }
      for (const share of shares) {
        const ledger = ledgerFor(group.ledgers, share.id, share.name);
        ledger.owes += share.amount;
      }
    } else {
      // 平均分攤要先把同一幣別的所有平均項目合併，最後再除以同行成員。
      // 這樣不會發生每一筆各自四捨五入，導致某個人被多扣或少扣好幾元。
      group.equalTotal += amount;
    }
  }

  return Array.from(byCurrency.values()).map((group) => {
    if (group.equalTotal > 0) {
      const equalShares = equalSharesForSettlement(group.equalTotal);
      for (const share of equalShares) {
        const ledger = ledgerFor(group.ledgers, share.id, share.name);
        ledger.owes += share.amount;
      }
      const roundedTotal = equalShares.reduce((sum, share) => sum + Number(share.amount || 0), 0);
      const diff = roundMoney(roundedTotal - Math.round(Number(group.equalTotal || 0)));
      if (diff) {
        group.notes.push(`平均分攤尾差 ${money(Math.abs(diff), group.currency)} 已略過，讓成員金額盡量一致`);
      }
    }
    const ledgers = Array.from(group.ledgers.values()).map((entry) => ({
      ...entry,
      paid: roundMoney(entry.paid),
      owes: roundMoney(entry.owes),
      net: roundMoney(entry.paid - entry.owes)
    }));
    return {
      currency: group.currency,
      ledgers,
      transfers: settlementTransfers(ledgers),
      notes: group.notes
    };
  });
}

function ledgerFor(map, id, name) {
  const key = participantKey({ lineUserId: id, displayName: name }) || String(id || name || "member");
  if (!map.has(key)) map.set(key, { id: key, name: name || id || key, paid: 0, owes: 0 });
  const entry = map.get(key);
  if (!isTechnicalIdentity(name) && name && (isTechnicalIdentity(entry.name) || String(name).length > String(entry.name || "").length)) {
    entry.name = name;
  }
  return entry;
}

function participantEntryById(id) {
  const target = cleanDisplayText(id);
  if (!target) return null;
  const member = expenseParticipants().find((entry) => participantMatches(entry, target));
  return member ? { id: member.lineUserId || member.displayName, name: actorName(member) } : null;
}

function equalSharesForSettlement(amount) {
  const members = expenseParticipants();
  if (!members.length) return [];
  const total = Math.round(Number(amount || 0));
  const share = Math.round(total / members.length);
  return members.map((member) => ({
    id: member.lineUserId || member.displayName,
    name: actorName(member),
    amount: share
  }));
}

function customSharesForSettlement(item = {}) {
  const shares = new Map();
  for (const entry of Array.isArray(item.customSplits) ? item.customSplits : []) {
    const name = entry.personName || participantNameById(entry.personId) || entry.personId || "成員";
    const id = entry.personId || name;
    const amount = Number(entry.amount || 0);
    if (!id || amount <= 0) continue;
    const key = participantKey({ lineUserId: id, displayName: name }) || String(id);
    const current = shares.get(key) || { id, name, amount: 0 };
    current.amount += amount;
    if (!isTechnicalIdentity(name) && (isTechnicalIdentity(current.name) || name.length > String(current.name || "").length)) current.name = name;
    shares.set(key, current);
  }
  return Array.from(shares.values());
}

function settlementTransfers(ledgers = []) {
  const creditors = ledgers
    .filter((entry) => entry.net > 0)
    .map((entry) => ({ ...entry, amount: entry.net }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = ledgers
    .filter((entry) => entry.net < 0)
    .map((entry) => ({ ...entry, amount: -entry.net }))
    .sort((a, b) => b.amount - a.amount);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount > 0) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: roundMoney(amount) });
    debtors[i].amount = roundMoney(debtors[i].amount - amount);
    creditors[j].amount = roundMoney(creditors[j].amount - amount);
    if (debtors[i].amount <= 0) i += 1;
    if (creditors[j].amount <= 0) j += 1;
  }
  return transfers.filter((entry) => entry.amount > 0);
}

function roundMoney(value) {
  return Math.round(Number(value || 0));
}

function renderTodos() {
  const trip = state.currentTrip;
  const rows = trip.todos.length
    ? trip.todos.map((todo) => todoRow(todo)).join("")
    : `<p class="muted">目前沒有待辦缺口。你在 LINE 裡說「膠囊列車還沒訂票」、「住宿已訂」、「eSIM 還沒處理」，AI 會自動放進這裡。</p>`;

  els.todosPanel.innerHTML = `
    <form class="todo-form">
      <label>
        分類
        <select name="category">
          ${todoCategoryOptions("other")}
        </select>
      </label>
      <label>
        狀態
        <select name="status">
          ${todoStatusOptions("todo")}
        </select>
      </label>
      <label>
        待辦
        <input name="title" autocomplete="off" placeholder="膠囊列車訂票、烤肉店訂位、eSIM" required />
      </label>
      <button class="primary-button" type="submit">新增待辦</button>
    </form>
    <div class="row-list">${rows}</div>
  `;
}

function todoRow(todo) {
  return `
    <article class="data-row todo-row">
      <div class="todo-status-dot" data-status="${escapeAttr(todo.status)}"></div>
      <div class="row-title">
        <strong>${escapeHtml(todo.title)}</strong>
        <small>${todoCategoryLabel(todo.category)} · ${todoStatusLabel(todo.status)}${todo.relatedTitle ? ` · ${escapeHtml(todo.relatedTitle)}` : ""}</small>
        ${todo.note ? `<small>備註：${linkifyText(todo.note)}</small>` : ""}
        <small class="audit-line">${auditLine(todo)}</small>
      </div>
      <select data-todo-id="${escapeAttr(todo.id)}" data-todo-field="status" aria-label="待辦狀態">
        ${todoStatusOptions(todo.status)}
      </select>
      <button class="danger-button" type="button" data-delete-todo="${escapeAttr(todo.id)}">刪除</button>
    </article>
  `;
}

function itineraryFields(item = {}) {
  return `
    <label>
      種類
      <select class="item-type-select" name="type">
        ${selectOptions(
          {
            activity: "一般行程",
            transport: "搭車",
            lodging: "住宿"
          },
          item.type || "activity"
        )}
      </select>
    </label>
    <label>
      日期
      <input type="date" name="date" value="${escapeAttr(item.date || "")}" />
    </label>
    <label>
      時間
      <input type="time" name="time" value="${escapeAttr(item.time || "")}" />
    </label>
    <label class="wide">
      項目
      <input name="title" autocomplete="off" placeholder="高鐵 857 次、海風號、羅東夜市、住宿訂金" value="${escapeAttr(item.title || "")}" required />
    </label>
    <label class="wide">
      地點 / 路線
      <input name="place" autocomplete="off" placeholder="台南到台北、宜蘭、羅東、飯店名稱" value="${escapeAttr(item.place || "")}" />
    </label>

    <section class="entry-money-card full" aria-label="花費與分帳">
      <div class="entry-money-title">
        <strong>花費與分帳</strong>
        <span>可平均分攤，也可依同行成員逐一指定金額。</span>
      </div>
      <div class="field-grid compact-grid">
        <label>
          金額
          <input type="number" name="price" min="0" step="1" inputmode="decimal" placeholder="0" value="${escapeAttr(item.price || "")}" />
        </label>
        <label>
          幣別
          <select name="currency">
            ${currencyOptions(item.currency || "TWD")}
          </select>
        </label>
        <label>
          誰先付
          <select name="payer">
            ${participantOptions(item.payer || state.user?.lineUserId || "")}
          </select>
        </label>
        <label>
          怎麼分帳
          <select name="splitMode">
            ${splitModeOptions(item.splitMode || "equal")}
          </select>
        </label>
      </div>
      ${memberSplitFields(item)}
    </section>

    <label class="wide">
      新增行程照片
      <input name="photoFiles" type="file" accept="image/*" multiple />
      <input type="hidden" name="existingPhotoUrls" value="${escapeAttr((item.photoUrls || []).join("\n"))}" />
    </label>
    ${photoManager(item.photoUrls)}

    <label class="full">
      備註
      <textarea name="note" placeholder="車次、座位、票種、集合點、訂位編號、早餐、入住退房、注意事項都寫這裡就好。">${escapeHtml(item.note || "")}</textarea>
    </label>
  `;
}

function itineraryRow(item) {
  return `
    <article class="data-row itinerary-row entry-row ${item.completed ? "is-completed" : ""}">
      <div class="entry-icon" data-type="${escapeAttr(item.type || "activity")}">${entryIconText(item.type)}</div>
      <div class="row-title">
        <div class="title-line">
          <strong>${escapeHtml(item.title)}</strong>
          ${item.completed ? `<span class="completed-pill">已完成</span>` : ""}
        </div>
        <small>${escapeHtml(formatWhen(item))}${item.place ? ` · ${escapeHtml(item.place)}` : ""}</small>
        ${paymentLine(item)}
        ${photoStrip(item.photoUrls)}
        ${item.note ? `<small>備註：${linkifyText(item.note)}</small>` : ""}
        <small class="audit-line">${auditLine(item)}</small>
      </div>
      <div class="row-controls entry-side">
        ${entryPrice(item)}
        <label class="completion-toggle">
          <input type="checkbox" data-item-completed data-item-id="${escapeAttr(item.id)}" ${item.completed ? "checked" : ""} />
          <span>已完成</span>
        </label>
        <button class="plain-button" type="button" data-edit-toggle="${escapeAttr(item.id)}">修改</button>
        <button class="danger-button" type="button" data-delete-item="${escapeAttr(item.id)}">刪除</button>
      </div>
    </article>
  `;
}

function groupedItineraryRows(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.date || item.checkInDate || (item.day ? `Day ${item.day}` : "未定日期");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries())
    .map(
      ([date, groupItems]) => `
        <section class="date-group">
          <h3>${escapeHtml(formatGroupDate(date))}</h3>
          ${groupItems.map((item) => itineraryRow(item)).join("")}
        </section>
      `
    )
    .join("");
}

function entryPrice(item) {
  const amount = Number(item.price || 0);
  if (!amount) return "";
  return `<span class="entry-price">${escapeHtml(money(amount, item.currency))}</span>`;
}

function paymentLine(item) {
  const amount = Number(item.price || 0);
  const parts = [];
  if (amount) {
    const payer = item.payerName || participantNameById(item.payer) || actorName(state.user || {});
    parts.push(`${payer} 先付 ${money(amount, item.currency)}`);
  }
  if (item.splitMode && item.splitMode !== "none") parts.push(splitModeLabel(item.splitMode));
  const custom = customSplitSummary(item);
  if (custom) parts.push(custom);
  return parts.length ? `<small class="payment-line">${escapeHtml(parts.join(" · "))}</small>` : "";
}

function customSplitSummary(item = {}) {
  if (item.splitMode !== "member_amounts") return "";
  const entries = (Array.isArray(item.customSplits) ? item.customSplits : [])
    .filter((entry) => Number(entry.amount || 0) > 0)
    .map((entry) => `${entry.personName || participantNameById(entry.personId) || "成員"} ${money(entry.amount, item.currency)}`);
  return entries.length ? `明細：${entries.join("、")}` : "尚未填成員金額";
}

function totalItineraryCost(items = []) {
  const byCurrency = new Map();
  for (const item of items) {
    const amount = Number(item.price || 0);
    if (!amount) continue;
    const currency = item.currency || "TWD";
    byCurrency.set(currency, (byCurrency.get(currency) || 0) + amount);
  }
  const currency = byCurrency.has("TWD") ? "TWD" : byCurrency.keys().next().value || "TWD";
  return { amount: byCurrency.get(currency) || 0, currency };
}

function expenseParticipants() {
  const members = Array.isArray(state.currentTrip?.members) ? state.currentTrip.members : [];
  const unique = new Map();
  const add = (member = {}) => {
    const displayName = cleanDisplayText(member.displayName || member.name || member.lineUserId || member.userId);
    const ids = Array.isArray(member.lineUserIds) ? member.lineUserIds : [];
    const lineUserId = cleanDisplayText(member.lineUserId || member.userId || ids.find(Boolean));
    const key = participantKey({ ...member, lineUserId, displayName });
    if (!key) return;
    const incoming = {
      ...member,
      lineUserId,
      lineUserIds: Array.from(new Set([lineUserId, ...ids].filter(Boolean))),
      displayName: displayName || lineUserId
    };
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, incoming);
      return;
    }
    existing.lineUserIds = Array.from(new Set([...(existing.lineUserIds || []), ...(incoming.lineUserIds || [])].filter(Boolean)));
    if (!isTechnicalIdentity(incoming.displayName) && (isTechnicalIdentity(existing.displayName) || incoming.displayName.length > String(existing.displayName || "").length)) {
      existing.displayName = incoming.displayName;
    }
    if (incoming.role === "owner" || existing.role === "owner") existing.role = "owner";
  };
  members.forEach(add);
  if (state.user?.lineUserId || state.user?.displayName) add(state.user);
  return Array.from(unique.values());
}

function participantKey(member = {}) {
  const nameKey = normalizeNameKey(member.displayName || member.name);
  if (nameKey) return `name:${nameKey}`;
  const ids = [member.lineUserId || member.userId, ...(Array.isArray(member.lineUserIds) ? member.lineUserIds : [])]
    .map((value) => cleanDisplayText(value))
    .filter((value) => value && !value.startsWith("manual:"));
  return ids[0] ? `id:${ids[0]}` : "";
}

function normalizeNameKey(value) {
  const name = cleanDisplayText(value);
  if (!name || isTechnicalIdentity(name)) return "";
  return name.replace(/\s+/g, "").toLowerCase();
}


function memberSplitFields(item = {}) {
  const members = expenseParticipants();
  if (!members.length) {
    return `<div class="member-split-card" data-custom-split-card hidden><p class="muted">先到「同行成員」加入家人，才能依成員分帳。</p></div>`;
  }
  return `
    <div class="member-split-card" data-custom-split-card ${item.splitMode === "member_amounts" ? "" : "hidden"}>
      <div class="member-split-title">
        <strong>依成員分帳</strong>
        <span>每個人旁邊填這筆行程要負擔的金額，最後結帳會一起計算。</span>
      </div>
      <div class="member-split-list">
        ${members.map((member) => {
          const id = member.lineUserId || member.displayName;
          const name = actorName(member);
          const amount = customSplitAmount(item.customSplits, id, name);
          return `
            <label class="member-split-row">
              <span>${escapeHtml(name)}</span>
              <input type="number" min="0" step="1" inputmode="decimal" placeholder="0" value="${escapeAttr(amount || "")}" data-custom-split-id="${escapeAttr(id)}" data-custom-split-name="${escapeAttr(name)}" />
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function customSplitAmount(customSplits = [], id = "", name = "") {
  const targetId = String(id || "").trim();
  const targetName = String(name || "").trim();
  const found = (Array.isArray(customSplits) ? customSplits : []).find((entry) => {
    return String(entry.personId || "").trim() === targetId || String(entry.personName || "").trim() === targetName;
  });
  return found ? Number(found.amount || 0) : "";
}

function participantOptions(selected) {
  const members = expenseParticipants();
  if (!members.length) return `<option value="">${escapeHtml(actorName(state.user))}</option>`;
  return members
    .map((member) => {
      const id = member.lineUserId || member.displayName;
      const label = actorName(member);
      return `<option value="${escapeAttr(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function participantNameById(id) {
  const target = cleanDisplayText(id);
  if (!target) return "";
  const member = expenseParticipants().find((entry) => participantMatches(entry, target));
  return member ? actorName(member) : "";
}

function participantMatches(member = {}, target = "") {
  const cleanTarget = cleanDisplayText(target);
  if (!cleanTarget) return false;
  const ids = [member.lineUserId || member.userId, ...(Array.isArray(member.lineUserIds) ? member.lineUserIds : [])]
    .map((value) => cleanDisplayText(value))
    .filter(Boolean);
  if (ids.includes(cleanTarget)) return true;
  return normalizeNameKey(member.displayName || member.name) === normalizeNameKey(cleanTarget);
}

function currencyOptions(selected) {
  return selectOptions({ TWD: "TWD", JPY: "JPY", KRW: "KRW", USD: "USD", EUR: "EUR", THB: "THB" }, selected || "TWD");
}

function splitModeOptions(selected) {
  return selectOptions(
    {
      equal: "平均分攤",
      member_amounts: "依成員分帳",
      payer_only: "先記帳不分攤"
    },
    selected || "equal"
  );
}

function splitModeLabel(value) {
  return { equal: "平均分攤", member_amounts: "依成員分帳", payer_only: "先記帳不分攤" }[value] || "平均分攤";
}

function cleanDisplayText(value) {
  return String(value || "").trim();
}

function itineraryDetail(item) {
  return "";
}

function renderWishes() {
  const trip = state.currentTrip;
  const rows = trip.wishes.length
    ? trip.wishes.map((wish) => wishRow(wish)).join("")
    : `<p class="muted">還沒有願望。大家想吃什麼、想去哪裡，都可以先丟進來。</p>`;
  els.wishesPanel.innerHTML = `
    <form class="wish-form">
      <label>
        種類
        <select name="type">
          <option value="food">想吃</option>
          <option value="spot">想去</option>
          <option value="activity">想玩</option>
          <option value="other">其他</option>
        </select>
      </label>
      <label>
        願望
        <input name="text" autocomplete="off" placeholder="想吃烤鴨、想去海邊" required />
      </label>
      <button class="primary-button" type="submit">加入願望</button>
    </form>
    <div class="row-list">${rows}</div>
  `;
}

function wishRow(wish) {
  return `
    <article class="data-row wish-row">
      <div class="row-title">
        <strong>${escapeHtml(wish.text)}</strong>
        <small>${wishTypeLabel(wish.type)} · ${escapeHtml(actorName(wish.author))}</small>
        <small class="audit-line">${auditLine(wish)}</small>
      </div>
      <select data-wish-id="${escapeAttr(wish.id)}" data-wish-field="type" aria-label="願望種類">
        ${wishTypeOptions(wish.type)}
      </select>
      <button class="primary-button wish-add-button" type="button" data-add-wish-itinerary="${escapeAttr(wish.id)}" ${wish.status === "planned" ? "disabled" : ""}>
        ${wish.status === "planned" ? "已加入行程" : "加入行程"}
      </button>
      <button class="danger-button" type="button" data-delete-wish="${escapeAttr(wish.id)}">刪除</button>
    </article>
  `;
}

function renderRecommendations() {
  const rec = state.recommendations;
  if (!rec) {
    els.recommendationsPanel.innerHTML = `<p class="muted">載入目的地推薦中</p>`;
    return;
  }

  els.recommendationsPanel.innerHTML = `
    <div class="recommendation-grid">
      <section class="recommendation-block">
        <div>
          <h3>${escapeHtml(rec.areaName)}玩法</h3>
          <button class="plain-button" type="button" data-use-location>用目前位置更新</button>
        </div>
        <ul class="route-list">
          ${rec.routes.map((route) => `<li>${escapeHtml(route)}</li>`).join("")}
        </ul>
      </section>
      <section class="recommendation-block">
        <h3>推薦景點</h3>
        ${rec.spots.map((item) => recommendationItem(item)).join("")}
      </section>
      <section class="recommendation-block">
        <h3>推薦美食</h3>
        ${rec.eats.map((item) => recommendationItem(item)).join("")}
      </section>
    </div>
  `;
}

function recommendationItem(item) {
  return `
    <article class="recommendation-item">
      <div class="row-title">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.area)} · ${escapeHtml(item.tag)} · ${linkifyText(item.note)}</small>
      </div>
      <button class="plain-button" type="button"
        data-add-recommendation
        data-name="${escapeAttr(item.name)}"
        data-area="${escapeAttr(item.area)}"
        data-note="${escapeAttr(item.note)}">加入</button>
    </article>
  `;
}

function renderMembers() {
  const trip = state.currentTrip;
  const members = Array.isArray(trip.members) ? trip.members : [];
  els.membersPanel.innerHTML = `
    <div class="member-summary member-invite-card">
      <div>
        <strong>邀請家人加入日記本</strong>
        <span>分享邀請連結後，家人第一次開啟會加入這本日記；加入後會永久保留在同行成員裡，之後再打開也可以查看與編輯。</span>
      </div>
      <button class="primary-button" type="button" data-invite-current>邀請家人</button>
    </div>
    <form class="member-summary manual-member-form">
      <div>
        <strong>手動新增同行成員</strong>
        <span>沒有使用 LINE、或只是要先放進分帳名單的人，可以先手動加入。</span>
      </div>
      <div class="manual-member-controls">
        <input name="displayName" autocomplete="off" placeholder="例如：阿嬤、舅舅" />
        <button class="compact-button" type="submit">新增</button>
      </div>
    </form>
    <div class="member-summary">
      <strong>同行成員</strong>
      <span>這裡顯示目前已加入這本日記、可查看與編輯的人；手動新增者會列入同行與分帳名單。</span>
    </div>
    <div class="member-list">
      ${members.length ? members
        .map(
          (member) => `
            <article class="member-row">
              <div>
                <strong>${escapeHtml(actorName(member))}</strong>
                <small>${member.manual ? "手動新增" : "加入日記本"}：${formatDateTime(member.joinedAt)}</small>
              </div>
              <span class="muted">${memberRoleLabel(member)}</span>
            </article>
          `
        )
        .join("") : `<p class="muted">還沒有同行成員。可以先邀請家人，或手動新增。</p>`}
    </div>
  `;
}

function memberRoleLabel(member = {}) {
  if (member.role === "owner") return "建立者";
  if (member.manual || member.role === "manual") return "手動新增";
  return "已加入，可編輯";
}

function renderPanels() {
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== state.activeTab;
  });
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab);
  });
  updateSettlementButtons();
}

function openPhotoViewer(url) {
  const viewer = document.querySelector("#photoViewer");
  const image = document.querySelector("#photoViewerImage");
  if (!viewer || !image || !url) return;
  image.src = url;
  viewer.hidden = false;
  document.body.classList.add("photo-viewer-open");
}

function closePhotoViewer() {
  const viewer = document.querySelector("#photoViewer");
  const image = document.querySelector("#photoViewerImage");
  if (!viewer || viewer.hidden) return;
  viewer.hidden = true;
  if (image) image.src = "";
  document.body.classList.remove("photo-viewer-open");
}


function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 桌面捷徑仍可用一般瀏覽器「加到主畫面」，service worker 失敗不阻擋主功能。
    });
  });
}

function updateManifestLink() {
  const link = document.querySelector("#dynamicManifest");
  if (!link) return;
  const params = new URLSearchParams();
  if (state.currentTrip?.id && !state.isCreating) {
    params.set("trip", state.currentTrip.id);
    const token = state.currentTrip.inviteToken || inviteTokenForTrip(state.currentTrip.id);
    if (token) params.set("invite", token);
  }
  link.href = `/manifest.webmanifest${params.toString() ? `?${params}` : ""}`;
}

function inviteTokenForTrip(tripId) {
  const entry = knownInvites().find((value) => value.startsWith(`${tripId}:`));
  return entry ? entry.slice(String(tripId).length + 1) : "";
}

function tripShortcutUrl(trip = state.currentTrip) {
  if (!trip) return `${location.origin}/app`;
  const params = new URLSearchParams({ trip: trip.id });
  const token = trip.inviteToken || inviteTokenForTrip(trip.id);
  if (token) params.set("invite", token);
  const baseUrl = (state.config?.baseUrl || location.origin).replace(/\/$/, "");
  return `${baseUrl}/app?${params}`;
}

function openShortcutModal() {
  if (!state.currentTrip) {
    toast("請先打開一本日記");
    return;
  }
  updateManifestLink();
  if (els.shortcutUrlInput) els.shortcutUrlInput.value = tripShortcutUrl();
  els.shortcutModal.hidden = false;
  document.body.classList.add("shortcut-modal-open");
}

function closeShortcutModal() {
  if (!els.shortcutModal || els.shortcutModal.hidden) return;
  els.shortcutModal.hidden = true;
  document.body.classList.remove("shortcut-modal-open");
}

async function installTripShortcut() {
  const url = tripShortcutUrl();
  if (els.shortcutUrlInput) els.shortcutUrlInput.value = url;

  if (state.deferredInstallPrompt) {
    const promptEvent = state.deferredInstallPrompt;
    state.deferredInstallPrompt = null;
    promptEvent.prompt();
    const result = await promptEvent.userChoice.catch(() => null);
    toast(result?.outcome === "accepted" ? "已建立桌面捷徑" : "已取消建立捷徑");
    return;
  }

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
  }
  toast("此瀏覽器不支援直接建立；已複製捷徑連結，可用手機瀏覽器加到主畫面");
}

async function copyShortcutUrl() {
  const url = tripShortcutUrl();
  if (els.shortcutUrlInput) els.shortcutUrlInput.value = url;
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    toast("捷徑連結已複製");
    return;
  }
  window.prompt("這本日記的捷徑連結", url);
}

async function inviteCurrentTrip() {
  const trip = state.currentTrip;
  if (!trip) return;
  const url = inviteUrl(trip);
  const text = `邀請你加入「${trip.title}」旅行日記，一起新增行程、照片與分帳：${url}`;

  if (
    window.liff &&
    state.liffReady &&
    typeof window.liff.shareTargetPicker === "function" &&
    window.liff.isApiAvailable("shareTargetPicker")
  ) {
    const result = await window.liff.shareTargetPicker([{ type: "text", text }]);
    toast(result ? "已送出分享" : "已取消分享");
    return;
  }

  if (navigator.share) {
    await navigator.share({ title: "薛家好好玩", text, url });
    return;
  }

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    toast("日記連結已複製");
    return;
  }

  window.prompt("日記連結", url);
}

function inviteUrl(trip) {
  const params = new URLSearchParams({ trip: trip.id, invite: trip.inviteToken });
  if (state.config?.liffId) return `https://liff.line.me/${state.config.liffId}?${params}`;
  const baseUrl = (state.config?.baseUrl || location.origin).replace(/\/$/, "");
  return `${baseUrl}/app?${params}`;
}

function knownInvites() {
  try {
    const values = JSON.parse(localStorage.getItem(KNOWN_INVITES_KEY) || "[]");
    return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function knownInviteParam() {
  return knownInvites().slice(0, 30).join(",");
}

function rememberInvite(tripId, inviteToken) {
  if (!tripId || !inviteToken) return;
  const entry = `${tripId}:${inviteToken}`;
  const next = [entry, ...knownInvites().filter((value) => !value.startsWith(`${tripId}:`))]
    .slice(0, 30);
  try {
    localStorage.setItem(KNOWN_INVITES_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable in some restricted in-app browsers.
  }
}

function forgetInvite(tripId) {
  if (!tripId) return;
  try {
    const next = knownInvites().filter((value) => !value.startsWith(`${tripId}:`));
    localStorage.setItem(KNOWN_INVITES_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable in some restricted in-app browsers.
  }
}

function accessPayload(extra = {}) {
  return {
    actor: state.user,
    inviteToken: state.currentTrip?.inviteToken || "",
    ...extra
  };
}

async function uploadImageFile(input) {
  const file = input?.files?.[0];
  if (!file) return "";
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/uploads", {
    method: "POST",
    body: formData
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "照片上傳失敗");
  input.value = "";
  return data.url;
}

async function uploadImageFiles(input) {
  const files = Array.from(input?.files || []);
  const urls = [];
  for (const file of files) {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/uploads", {
      method: "POST",
      body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "照片上傳失敗");
    urls.push(data.url);
  }
  if (input) input.value = "";
  return urls;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  let url = path;
  if (method === "GET") {
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}_=${Date.now()}`;
  }
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function formObject(form) {
  const formData = new FormData(form);
  const value = Object.fromEntries(formData.entries());
  if ("payer" in value) {
    if (!value.payer && state.user?.lineUserId) value.payer = state.user.lineUserId;
    value.payerName = participantNameById(value.payer) || actorName(state.user || {});
  }
  const splitInputs = Array.from(form.querySelectorAll("[data-custom-split-id]"));
  if (splitInputs.length) {
    value.customSplits = splitInputs
      .map((input) => ({
        personId: input.dataset.customSplitId || input.dataset.customSplitName || "",
        personName: input.dataset.customSplitName || participantNameById(input.dataset.customSplitId) || input.dataset.customSplitId || "",
        amount: Number(input.value || 0)
      }))
      .filter((entry) => entry.personId && entry.amount > 0);
    for (const key of Object.keys(value)) {
      if (key.startsWith("splitAmount__")) delete value[key];
    }
    if (value.splitMode !== "member_amounts") value.customSplits = [];
  }
  const photoFileInput = form.querySelector("input[name='photoFiles']");
  if (photoFileInput) {
    const keepInputs = Array.from(form.querySelectorAll("input[name='keepPhotoUrls']"));
    const existing = keepInputs.length
      ? keepInputs.filter((input) => input.checked).map((input) => input.value)
      : String(value.existingPhotoUrls || "")
          .split(/[\s,，\n]+/)
          .map((url) => url.trim())
          .filter(Boolean);
    const uploaded = await uploadImageFiles(photoFileInput);
    value.photoUrls = [...existing, ...uploaded];
    delete value.photoFiles;
    delete value.existingPhotoUrls;
    delete value.keepPhotoUrls;
  }
  return value;
}

function syncTypeFields(form) {
  if (!form) return;
  const type = form.querySelector(".item-type-select")?.value || "activity";
  form.querySelectorAll("[data-type-fields]").forEach((section) => {
    section.hidden = section.dataset.typeFields !== type;
  });
}

function syncSplitFields(form) {
  if (!form) return;
  const splitMode = form.querySelector("select[name='splitMode']")?.value || "equal";
  form.querySelectorAll("[data-custom-split-card]").forEach((section) => {
    section.hidden = splitMode !== "member_amounts";
  });
}

function stat(label, value) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function statusOptions(kind, selected) {
  const labels =
    kind === "ticket"
      ? { none: "不用購票", needed: "要購票", done: "已購票" }
      : { none: "不用訂位", needed: "要訂位", done: "已訂位" };
  return selectOptions(labels, selected);
}

function todoCategoryOptions(selected) {
  const labels = {
    flight: "機票",
    lodging: "住宿",
    ticket: "票券",
    reservation: "訂位",
    hours: "營業時間",
    transport: "交通",
    insurance: "旅平險",
    esim: "eSIM",
    packing: "行李",
    other: "其他"
  };
  return selectOptions(labels, selected);
}

function todoStatusOptions(selected) {
  const labels = {
    todo: "未處理",
    done: "已完成",
    not_needed: "不用處理",
    confirm: "待確認",
    need_ticket: "未訂票",
    need_reservation: "未訂位",
    need_hours: "需查營業時間",
    need_transport: "需查交通"
  };
  return selectOptions(labels, selected);
}

function selectOptions(labels, selected) {
  return Object.entries(labels)
    .map(
      ([value, label]) =>
        `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
}

function wishTypeOptions(selected) {
  const labels = { food: "想吃", spot: "想去", activity: "想玩", other: "其他" };
  return selectOptions(labels, selected);
}

function wishStatusOptions(selected) {
  const labels = { open: "想去/想吃", planned: "已排入", done: "已完成" };
  return selectOptions(labels, selected);
}

function wishTypeLabel(type) {
  return { food: "想吃", spot: "想去", activity: "想玩", other: "其他" }[type] || "其他";
}

function todoCategoryLabel(value) {
  return {
    flight: "機票",
    lodging: "住宿",
    ticket: "票券",
    reservation: "訂位",
    hours: "營業時間",
    transport: "交通",
    insurance: "旅平險",
    esim: "eSIM",
    packing: "行李",
    other: "其他"
  }[value] || "其他";
}

function todoStatusLabel(value) {
  return {
    todo: "未處理",
    done: "已完成",
    not_needed: "不用處理",
    confirm: "待確認",
    need_ticket: "未訂票",
    need_reservation: "未訂位",
    need_hours: "需查營業時間",
    need_transport: "需查交通"
  }[value] || "未處理";
}

function itineraryTypeLabel(type) {
  return { activity: "行程", transport: "搭車", lodging: "住宿" }[type] || "行程";
}

function entryIconText(type) {
  return { activity: "行", transport: "車", lodging: "宿" }[type] || "行";
}

function breakfastLabel(value) {
  return { unknown: "還不確定", included: "有早餐", not_included: "沒有早餐" }[value] || "還不確定";
}

function formatWhen(item) {
  if (item.type === "lodging" && (item.checkInDate || item.checkOutDate)) {
    return `${item.checkInDate || "未定入住"} 到 ${item.checkOutDate || "未定退房"}`;
  }
  const start = [item.date, item.time].filter(Boolean).join(" ");
  if (start) return start;
  if (item.day) return `Day ${item.day}`;
  return "未定時間";
}

function formatGroupDate(value) {
  if (String(value).startsWith("Day ")) return value;
  if (value === "未定日期") return value;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-Hant-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  });
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

function auditLine(entry) {
  return `新增：${actorName(entry.createdBy)} ${formatDateTime(entry.createdAt)} · 最後修改：${actorName(entry.updatedBy)} ${formatDateTime(entry.updatedAt)}`;
}

function actorName(actor) {
  const name = cleanDisplayName(actor?.displayName || actor?.name || "");
  if (name && !isTechnicalIdentity(name)) return name;
  const lineName = cleanDisplayName(actor?.lineDisplayName || "");
  if (lineName && !isTechnicalIdentity(lineName)) return lineName;
  const id = cleanDisplayName(actor?.lineUserId || actor?.userId || "");
  if (id && !isTechnicalIdentity(id)) return id;
  return id && /^U[a-f0-9]{20,}$/i.test(id) ? "LINE 使用者" : "尚未設定名稱";
}

function joinParts(parts, separator) {
  return parts.filter(Boolean).join(separator);
}

function photoManager(photoUrls = []) {
  if (!photoUrls.length) return "";
  return `
    <div class="photo-manager wide">
      <strong>已放入的照片</strong>
      <small>預設會保留。取消勾選後按「儲存修改」，就會從這筆行程移除。</small>
      <div class="photo-manager-grid">
        ${photoUrls
          .map(
            (url, index) => `
              <label class="photo-keep-card">
                <input type="checkbox" name="keepPhotoUrls" value="${escapeAttr(url)}" checked />
                <img src="${escapeAttr(url)}" alt="已放入照片 ${index + 1}" loading="lazy" />
                <span>保留這張</span>
              </label>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function photoStrip(photoUrls = []) {
  if (!photoUrls.length) return "";
  return `
    <div class="photo-strip">
      ${photoUrls
        .slice(0, 8)
        .map(
          (url) => `
            <button class="photo-thumb" type="button" data-photo-open="${escapeAttr(url)}">
              <img src="${escapeAttr(url)}" alt="行程照片，點一下看完整照片" loading="lazy" />
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function money(value, currency = "TWD") {
  const number = Number(value || 0);
  if (!number) return `${currency} 0`;
  return `${currency} ${number.toLocaleString("zh-Hant-TW")}`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function showError(error) {
  console.error(error);
  toast(error.message || "操作失敗");
}


function linkifyText(value) {
  const text = String(value ?? "");
  if (!text) return "";

  const urlPattern = /(https?:\/\/[^\s<>'"]+|www\.[^\s<>'"]+)/gi;
  const trailingChars = ".,;:!?，。！？、）)]}」』》";
  let output = "";
  let lastIndex = 0;
  let match;

  while ((match = urlPattern.exec(text)) !== null) {
    output += escapeHtml(text.slice(lastIndex, match.index));
    let label = match[0];
    let trailing = "";
    while (label && trailingChars.includes(label.at(-1))) {
      trailing = label.at(-1) + trailing;
      label = label.slice(0, -1);
    }

    const href = normalizeHttpUrl(label);
    if (href) {
      output += `<a class="inline-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" data-external-link>${escapeHtml(label)}</a>`;
    } else {
      output += escapeHtml(label);
    }
    output += escapeHtml(trailing);
    lastIndex = match.index + match[0].length;
  }

  output += escapeHtml(text.slice(lastIndex));
  return output.replace(/\r?\n/g, "<br>");
}

function normalizeHttpUrl(rawUrl) {
  if (!rawUrl) return "";
  const candidate = rawUrl.startsWith("www.") ? `https://${rawUrl}` : rawUrl;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function openExternalLink(rawUrl) {
  const href = normalizeHttpUrl(rawUrl);
  if (!href) return;
  if (window.liff?.isInClient?.()) {
    window.liff.openWindow({ url: href, external: true });
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return map[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cssUrl(value) {
  return String(value || "").replace(/["\\]/g, "");
}

function cryptoRandom() {
  const array = new Uint32Array(2);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(array);
    return Array.from(array, (part) => part.toString(16)).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

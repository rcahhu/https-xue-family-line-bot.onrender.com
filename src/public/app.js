const state = {
  config: null,
  user: null,
  liffReady: false,
  trips: [],
  currentTrip: null,
  isCreating: false,
  activeTab: "itinerary",
  recommendations: null,
  recommendationTripId: null
};

const KNOWN_INVITES_KEY = "xue-family-known-trip-invites";

const els = {
  userBadge: document.querySelector("#userBadge"),
  inviteButton: document.querySelector("#inviteButton"),
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
  toast: document.querySelector("#toast")
};

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  showError(event.reason || new Error("操作失敗"));
});

init().catch(showError);

async function init() {
  bindEvents();
  state.config = await api("/api/config");
  state.user = await resolveUser();
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
      body: { actor: state.user, patch }
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

    await api(`/api/trips/${state.currentTrip.id}`, {
      method: "DELETE",
      body: { actor: state.user }
    });
    state.currentTrip = null;
    await loadTrips();
    history.replaceState(null, "", "/app");
    render();
    toast("日記已刪除");
  });

  els.tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    state.activeTab = tab.dataset.tab;
    renderPanels();
  });

  els.inviteButton.addEventListener("click", () => inviteCurrentTrip().catch(showError));
  els.quickAddButton.addEventListener("click", () => {
    if (!state.currentTrip) return;
    state.activeTab = "itinerary";
    renderPanels();
    const addBox = document.querySelector("#addItineraryBox");
    if (addBox) {
      addBox.open = true;
      addBox.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => addBox.querySelector("input[name='title']")?.focus(), 250);
    }
  });

  els.itineraryPanel.addEventListener("submit", async (event) => {
    if (event.target.matches(".item-form")) {
      event.preventDefault();
      const item = await formObject(event.target);
      await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
        method: "POST",
        body: { actor: state.user, item }
      });
      event.target.reset();
      syncTypeFields(event.target);
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
        body: { actor: state.user, patch }
      });
      await refreshCurrentTrip();
      toast("行程已修改");
    }
  });

  els.itineraryPanel.addEventListener("change", (event) => {
    const typeSelect = event.target.closest(".item-type-select");
    if (typeSelect) syncTypeFields(typeSelect.form);
  });

  els.itineraryPanel.addEventListener("click", async (event) => {
    const editButton = event.target.closest("[data-edit-toggle]");
    if (editButton) {
      editButton.closest("article")?.querySelector("details")?.setAttribute("open", "");
      return;
    }

    const button = event.target.closest("[data-delete-item]");
    if (!button) return;
    if (!window.confirm("確定刪除這筆行程嗎？")) return;
    await api(`/api/trips/${state.currentTrip.id}/itinerary/${button.dataset.deleteItem}`, {
      method: "DELETE",
      body: { actor: state.user }
    });
    await refreshCurrentTrip();
    toast("行程已刪除");
  });

  els.todosPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".todo-form")) return;
    event.preventDefault();
    const todo = await formObject(event.target);
    await api(`/api/trips/${state.currentTrip.id}/todos`, {
      method: "POST",
      body: { actor: state.user, todo }
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
        actor: state.user,
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
      body: { actor: state.user }
    });
    await refreshCurrentTrip();
    toast("待辦已刪除");
  });

  els.wishesPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".wish-form")) return;
    event.preventDefault();
    const wish = await formObject(event.target);
    await api(`/api/trips/${state.currentTrip.id}/wishes`, {
      method: "POST",
      body: { actor: state.user, wish }
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
        actor: state.user,
        patch: { [target.dataset.wishField]: target.value }
      }
    });
    await refreshCurrentTrip();
  });

  els.wishesPanel.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-wish]");
    if (!button) return;
    if (!window.confirm("確定刪除這個願望嗎？")) return;
    await api(`/api/trips/${state.currentTrip.id}/wishes/${button.dataset.deleteWish}`, {
      method: "DELETE",
      body: { actor: state.user }
    });
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
        actor: state.user,
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
    return {
      lineUserId: profile.userId,
      displayName: profile.displayName || "LINE 旅伴"
    };
  } catch (error) {
    console.warn("LIFF init failed, using guest mode.", error);
    return fallback;
  }
}

function guestUser() {
  const key = "xue-family-guest-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `guest-${cryptoRandom()}`;
    localStorage.setItem(key, id);
  }
  return { lineUserId: id, displayName: "訪客旅伴" };
}

async function joinTripFromInvite(tripId, inviteToken) {
  try {
    const { trip } = await api(`/api/trips/${tripId}/join`, {
      method: "POST",
      body: { inviteToken, actor: state.user }
    });
    rememberInvite(tripId, inviteToken);
    state.currentTrip = trip;
    toast(`已加入「${trip.title}」`);
  } catch (error) {
    console.warn(error);
  }
}

async function loadTrips() {
  const params = new URLSearchParams({ userId: state.user.lineUserId });
  const invites = knownInviteParam();
  if (invites) params.set("invites", invites);
  const { trips } = await api(`/api/trips?${params}`);
  state.trips = trips;
  renderTripList();
}

async function selectTrip(tripId, inviteToken = "") {
  const params = new URLSearchParams({
    userId: state.user.lineUserId,
    displayName: state.user.displayName
  });
  if (inviteToken) params.set("invite", inviteToken);
  const { trip } = await api(`/api/trips/${tripId}?${params}`);
  if (inviteToken) rememberInvite(tripId, inviteToken);
  state.isCreating = false;
  state.currentTrip = trip;
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
  const { trip } = await api(`/api/trips/${state.currentTrip.id}?${params}`);
  state.currentTrip = trip;
  render();
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
      toast("已更新附近熱門");
    },
    () => toast("無法取得定位，先用日記地區推薦")
  );
}

function render() {
  renderUser();
  renderTripList();
  const hasTrip = Boolean(state.currentTrip);
  const isCreating = Boolean(state.isCreating);
  document.body.classList.toggle("has-trip", hasTrip);
  document.body.classList.toggle("no-trip", !hasTrip && !isCreating);
  document.body.classList.toggle("is-creating", isCreating);
  els.newDiaryView.hidden = !isCreating;
  els.emptyState.hidden = hasTrip || isCreating;
  els.tripView.hidden = !hasTrip || isCreating;
  els.inviteButton.disabled = !hasTrip;
  els.quickAddButton.hidden = !hasTrip || isCreating;
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
  renderRecommendations();
  renderMembers();
  renderPanels();
}

function renderUser() {
  els.userBadge.textContent = state.user?.displayName || "旅伴";
}

function renderTripList() {
  if (!state.trips.length) {
    els.tripList.innerHTML = `<p class="muted">還沒有日記</p>`;
    return;
  }
  els.tripList.innerHTML = state.trips
    .map(
      (trip, index) => `
        <button class="trip-link cover-${index % 4} ${state.currentTrip?.id === trip.id ? "is-active" : ""}" type="button" data-trip-id="${escapeAttr(trip.id)}">
          <span class="trip-cover">
            <strong>${escapeHtml(trip.title)}</strong>
          </span>
          <span>${escapeHtml(tripMeta(trip))}</span>
        </button>
      `
    )
    .join("");
}

function renderStats() {
  const trip = state.currentTrip;
  const budget = trip.itinerary.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const transportCount = trip.itinerary.filter((item) => item.type === "transport").length;
  const lodgingCount = trip.itinerary.filter((item) => item.type === "lodging").length;
  const openTodoCount = trip.todos.filter((todo) => !["done", "not_needed"].includes(todo.status)).length;
  const memberNames = trip.members.map((member) => member.displayName).join("、") || "尚未加入";
  els.tripStats.innerHTML = [
    stat("總預估花費", money(budget)),
    stat("行程", `${trip.itinerary.length} 筆`),
    stat("待辦缺口", `${openTodoCount} 個`),
    stat("搭車", `${transportCount} 筆`),
    stat("住宿", `${lodgingCount} 筆`),
    stat("同行人數", trip.peopleCount || "未填"),
    stat("編輯成員", `${trip.members.length} 位`),
    stat("成員名單", memberNames),
    stat("最後修改", `${actorName(trip.updatedBy)} · ${formatDateTime(trip.updatedAt)}`)
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
  return `${dates} · ${trip.itinerary.length} 筆行程 · ${people} · 編輯成員 ${trip.members.length} 位`;
}

function renderItinerary() {
  const trip = state.currentTrip;
  const rows = trip.itinerary.length
    ? groupedItineraryRows(trip.itinerary)
    : `<p class="muted">還沒有行程。先用上方表單新增一筆。</p>`;

  els.itineraryPanel.innerHTML = `
    <details id="addItineraryBox" class="add-entry">
      <summary>新增行程</summary>
      <form class="item-form">
        ${itineraryFields()}
        <button class="primary-button full" type="submit">新增行程</button>
      </form>
    </details>
    <div class="row-list">${rows}</div>
  `;
  els.itineraryPanel.querySelectorAll(".item-form, .item-edit-form").forEach(syncTypeFields);
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
        ${todo.note ? `<small>備註：${escapeHtml(todo.note)}</small>` : ""}
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
      標題
      <input name="title" autocomplete="off" placeholder="羅東夜市、台鐵到宜蘭、礁溪住宿" value="${escapeAttr(item.title || "")}" required />
    </label>
    <label class="wide">
      地點
      <input name="place" autocomplete="off" placeholder="宜蘭、羅東、台北車站" value="${escapeAttr(item.place || "")}" />
    </label>
    <label class="wide">
      行程照片
      <input name="photoFiles" type="file" accept="image/*" multiple />
      <input type="hidden" name="existingPhotoUrls" value="${escapeAttr((item.photoUrls || []).join("\n"))}" />
    </label>

    <section class="type-fields full" data-type-fields="transport">
      <label class="full">
        搭車一句話
        <input name="transportSummary" placeholder="台鐵 123 次，09:00 台北到宜蘭，台北車站搭，約 1 小時 20 分" value="${escapeAttr(item.transportSummary || "")}" />
      </label>
      <details class="soft-details">
        <summary>要更清楚再填車次、上下車地點</summary>
        <div class="field-grid">
          <label>交通方式<input name="transportMode" placeholder="台鐵、高鐵、客運、計程車" value="${escapeAttr(item.transportMode || "")}" /></label>
          <label>車名/路線<input name="transportName" placeholder="台鐵、葛瑪蘭客運" value="${escapeAttr(item.transportName || "")}" /></label>
          <label>車次/班次<input name="transportNumber" placeholder="123、1915" value="${escapeAttr(item.transportNumber || "")}" /></label>
          <label>從哪裡<input name="fromPlace" placeholder="台北車站" value="${escapeAttr(item.fromPlace || "")}" /></label>
          <label>到哪裡<input name="toPlace" placeholder="宜蘭車站" value="${escapeAttr(item.toPlace || "")}" /></label>
          <label>在哪坐<input name="boardingPlace" placeholder="台北車站 4 月台" value="${escapeAttr(item.boardingPlace || "")}" /></label>
          <label>時長<input name="duration" placeholder="1 小時 20 分" value="${escapeAttr(item.duration || "")}" /></label>
        </div>
      </details>
    </section>

    <section class="type-fields full" data-type-fields="lodging">
      <label class="full">
        住宿一句話
        <input name="lodgingSummary" placeholder="礁溪老爺，雙人房，含早餐，15:00 入住" value="${escapeAttr(item.lodgingSummary || "")}" />
      </label>
      <details class="soft-details">
        <summary>要更清楚再填地址、早餐、訂房編號</summary>
        <div class="field-grid">
          <label>住哪<input name="lodgingName" placeholder="飯店 / 民宿名稱" value="${escapeAttr(item.lodgingName || "")}" /></label>
          <label>地址<input name="lodgingAddress" placeholder="住宿地址" value="${escapeAttr(item.lodgingAddress || "")}" /></label>
          <label>入住日<input type="date" name="checkInDate" value="${escapeAttr(item.checkInDate || "")}" /></label>
          <label>退房日<input type="date" name="checkOutDate" value="${escapeAttr(item.checkOutDate || "")}" /></label>
          <label>
            早餐
            <select name="breakfast">
              ${selectOptions(
                { unknown: "還不確定", included: "有早餐", not_included: "沒有早餐" },
                item.breakfast || "unknown"
              )}
            </select>
          </label>
          <label>訂房編號<input name="confirmationNumber" placeholder="可空白" value="${escapeAttr(item.confirmationNumber || "")}" /></label>
        </div>
      </details>
    </section>

    <details class="more-fields full">
      <summary>購票、訂位、價格、備註</summary>
      <div class="field-grid">
        <label>
          是否購票
          <select name="ticketStatus">
            ${statusOptions("ticket", item.ticketStatus || "none")}
          </select>
        </label>
        <label>
          是否訂位
          <select name="reservationStatus">
            ${statusOptions("reservation", item.reservationStatus || "none")}
          </select>
        </label>
        <label>價格<input type="number" name="price" min="0" step="1" value="${Number(item.price || 0)}" /></label>
        <label>幣別<input name="currency" value="${escapeAttr(item.currency || "TWD")}" /></label>
        <label class="full">備註<textarea name="note" placeholder="集合點、注意事項、誰要先付款">${escapeHtml(item.note || "")}</textarea></label>
      </div>
    </details>
  `;
}

function itineraryRow(item) {
  return `
    <article class="data-row itinerary-row entry-row">
      <div class="entry-icon" data-type="${escapeAttr(item.type || "activity")}">${entryIconText(item.type)}</div>
      <div class="row-title">
        <div class="title-line">
          <strong>${escapeHtml(item.title)}</strong>
        </div>
        <small>${escapeHtml(formatWhen(item))}${item.place ? ` · ${escapeHtml(item.place)}` : ""}</small>
        ${itineraryDetail(item)}
        ${photoStrip(item.photoUrls)}
        ${item.note ? `<small>備註：${escapeHtml(item.note)}</small>` : ""}
        <small class="audit-line">${auditLine(item)}</small>
      </div>
      <div class="row-controls entry-side">
        <span class="entry-price">${money(item.price || 0, item.currency)}</span>
        <button class="plain-button" type="button" data-edit-toggle="${escapeAttr(item.id)}">修改</button>
        <button class="danger-button" type="button" data-delete-item="${escapeAttr(item.id)}">刪除</button>
      </div>
      <details class="edit-details full">
        <summary>修改這筆資料</summary>
        <form class="item-edit-form" data-item-id="${escapeAttr(item.id)}">
          ${itineraryFields(item)}
          <button class="primary-button full" type="submit">儲存修改</button>
        </form>
      </details>
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

function itineraryDetail(item) {
  if (item.type === "transport") {
    const details = [
      item.transportSummary,
      joinParts([item.transportMode, item.transportName, item.transportNumber], " "),
      joinParts([item.fromPlace, item.toPlace], " 到 "),
      item.boardingPlace ? `在哪坐：${item.boardingPlace}` : "",
      item.duration ? `時長：${item.duration}` : ""
    ].filter(Boolean);
    return details.length ? `<small>搭車：${escapeHtml(details.join(" · "))}</small>` : "";
  }

  if (item.type === "lodging") {
    const details = [
      item.lodgingSummary,
      item.lodgingName ? `住哪：${item.lodgingName}` : "",
      item.lodgingAddress ? `地址：${item.lodgingAddress}` : "",
      item.checkInDate || item.checkOutDate
        ? `入住/退房：${item.checkInDate || "未定"} 到 ${item.checkOutDate || "未定"}`
        : "",
      `早餐：${breakfastLabel(item.breakfast)}`,
      item.confirmationNumber ? `訂房編號：${item.confirmationNumber}` : ""
    ].filter(Boolean);
    return details.length ? `<small>住宿：${escapeHtml(details.join(" · "))}</small>` : "";
  }

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
      <select data-wish-id="${escapeAttr(wish.id)}" data-wish-field="status" aria-label="願望狀態">
        ${wishStatusOptions(wish.status)}
      </select>
      <button class="danger-button" type="button" data-delete-wish="${escapeAttr(wish.id)}">刪除</button>
    </article>
  `;
}

function renderRecommendations() {
  const rec = state.recommendations;
  if (!rec) {
    els.recommendationsPanel.innerHTML = `<p class="muted">載入附近熱門中</p>`;
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
        <h3>熱門景點</h3>
        ${rec.spots.map((item) => recommendationItem(item)).join("")}
      </section>
      <section class="recommendation-block">
        <h3>熱門美食</h3>
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
        <small>${escapeHtml(item.area)} · ${escapeHtml(item.tag)} · ${escapeHtml(item.note)}</small>
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
  els.membersPanel.innerHTML = `
    <div class="member-summary">
      <strong>編輯成員 ${trip.members.length} 位</strong>
      <span>${escapeHtml(trip.members.map((member) => member.displayName).join("、"))}</span>
    </div>
    <div class="member-list">
      ${trip.members
        .map(
          (member) => `
            <article class="member-row">
              <div>
                <strong>${escapeHtml(member.displayName)}</strong>
                <small>加入：${formatDateTime(member.joinedAt)}</small>
              </div>
              <span class="muted">${member.role === "owner" ? "建立者" : "協作者"}</span>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderPanels() {
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== state.activeTab;
  });
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.tab === state.activeTab);
  });
}

async function inviteCurrentTrip() {
  const trip = state.currentTrip;
  if (!trip) return;
  const url = inviteUrl(trip);
  const text = `一起編輯「${trip.title}」旅行日記：${url}`;

  if (
    window.liff &&
    state.liffReady &&
    typeof window.liff.shareTargetPicker === "function" &&
    window.liff.isApiAvailable("shareTargetPicker")
  ) {
    const result = await window.liff.shareTargetPicker([{ type: "text", text }]);
    toast(result ? "已送出邀請" : "已取消邀請");
    return;
  }

  if (navigator.share) {
    await navigator.share({ title: "薛家好好玩", text, url });
    return;
  }

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    toast("邀請連結已複製");
    return;
  }

  window.prompt("邀請連結", url);
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
  const response = await fetch(path, {
    method: options.method || "GET",
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
  const value = Object.fromEntries(new FormData(form).entries());
  const photoFileInput = form.querySelector("input[name='photoFiles']");
  if (photoFileInput) {
    const existing = String(value.existingPhotoUrls || "")
      .split(/[\s,，\n]+/)
      .map((url) => url.trim())
      .filter(Boolean);
    const uploaded = await uploadImageFiles(photoFileInput);
    value.photoUrls = [...existing, ...uploaded];
    delete value.photoFiles;
    delete value.existingPhotoUrls;
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
  return actor?.displayName || actor?.name || "旅伴";
}

function joinParts(parts, separator) {
  return parts.filter(Boolean).join(separator);
}

function photoStrip(photoUrls = []) {
  if (!photoUrls.length) return "";
  return `
    <div class="photo-strip">
      ${photoUrls
        .slice(0, 4)
        .map((url) => `<img src="${escapeAttr(url)}" alt="行程照片" loading="lazy" />`)
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
  crypto.getRandomValues(array);
  return Array.from(array, (part) => part.toString(16)).join("");
}

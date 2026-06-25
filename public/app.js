const state = {
  config: null,
  user: null,
  liffReady: false,
  trips: [],
  currentTrip: null,
  activeTab: "itinerary",
  recommendations: null,
  recommendationTripId: null
};

const els = {
  userBadge: document.querySelector("#userBadge"),
  inviteButton: document.querySelector("#inviteButton"),
  createTripForm: document.querySelector("#createTripForm"),
  tripTitleInput: document.querySelector("#tripTitleInput"),
  tripAreaInput: document.querySelector("#tripAreaInput"),
  tripList: document.querySelector("#tripList"),
  emptyState: document.querySelector("#emptyState"),
  tripView: document.querySelector("#tripView"),
  tripSettingsForm: document.querySelector("#tripSettingsForm"),
  currentTripTitle: document.querySelector("#currentTripTitle"),
  currentTripArea: document.querySelector("#currentTripArea"),
  tripStats: document.querySelector("#tripStats"),
  tabs: document.querySelector(".tabs"),
  itineraryPanel: document.querySelector("#itineraryPanel"),
  wishesPanel: document.querySelector("#wishesPanel"),
  recommendationsPanel: document.querySelector("#recommendationsPanel"),
  membersPanel: document.querySelector("#membersPanel"),
  toast: document.querySelector("#toast")
};

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  showError(event.reason || new Error("發生錯誤"));
});

init().catch((error) => showError(error));

async function init() {
  bindEvents();
  state.config = await api("/api/config");
  state.user = await resolveUser();
  renderUser();

  const params = new URLSearchParams(location.search);
  const tripId = params.get("trip");
  const inviteToken = params.get("invite");

  if (tripId && inviteToken) {
    await joinTripFromInvite(tripId, inviteToken);
  }

  await loadTrips();

  if (tripId) {
    await selectTrip(tripId, inviteToken);
  } else if (!state.currentTrip && state.trips.length) {
    await selectTrip(state.trips[0].id);
  } else {
    render();
  }
}

function bindEvents() {
  els.createTripForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = els.tripTitleInput.value.trim();
    const area = els.tripAreaInput.value.trim() || title;
    if (!title) return;
    const { trip } = await api("/api/trips", {
      method: "POST",
      body: { title, area, actor: state.user }
    });
    els.createTripForm.reset();
    await loadTrips();
    await selectTrip(trip.id);
    toast(`已新增「${trip.title}」`);
  });

  els.tripList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-trip-id]");
    if (!button) return;
    await selectTrip(button.dataset.tripId);
  });

  els.tripSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const patch = {
      title: els.currentTripTitle.value.trim(),
      area: els.currentTripArea.value.trim()
    };
    await api(`/api/trips/${state.currentTrip.id}`, {
      method: "PATCH",
      body: { actor: state.user, patch }
    });
    await refreshCurrentTrip();
    await loadTrips();
    await loadRecommendations(true);
    toast("已儲存");
  });

  els.tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    state.activeTab = tab.dataset.tab;
    renderPanels();
  });

  els.inviteButton.addEventListener("click", () => inviteCurrentTrip().catch(showError));

  els.itineraryPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".item-form")) return;
    event.preventDefault();
    const formData = new FormData(event.target);
    const item = Object.fromEntries(formData.entries());
    await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
      method: "POST",
      body: { actor: state.user, item }
    });
    event.target.reset();
    await refreshCurrentTrip();
    toast("已加入行程");
  });

  els.itineraryPanel.addEventListener("change", async (event) => {
    const target = event.target.closest("[data-item-field]");
    if (!target) return;
    const itemId = target.dataset.itemId;
    const field = target.dataset.itemField;
    const value = field === "price" ? Number(target.value || 0) : target.value;
    await api(`/api/trips/${state.currentTrip.id}/itinerary/${itemId}`, {
      method: "PATCH",
      body: { actor: state.user, patch: { [field]: value } }
    });
    await refreshCurrentTrip();
  });

  els.itineraryPanel.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-item]");
    if (!button) return;
    await api(`/api/trips/${state.currentTrip.id}/itinerary/${button.dataset.deleteItem}`, {
      method: "DELETE",
      body: { actor: state.user }
    });
    await refreshCurrentTrip();
    toast("已刪除行程");
  });

  els.wishesPanel.addEventListener("submit", async (event) => {
    if (!event.target.matches(".wish-form")) return;
    event.preventDefault();
    const formData = new FormData(event.target);
    const wish = Object.fromEntries(formData.entries());
    await api(`/api/trips/${state.currentTrip.id}/wishes`, {
      method: "POST",
      body: { actor: state.user, wish }
    });
    event.target.reset();
    await refreshCurrentTrip();
    toast("已加入許願池");
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
    await api(`/api/trips/${state.currentTrip.id}/wishes/${button.dataset.deleteWish}`, {
      method: "DELETE",
      body: { actor: state.user }
    });
    await refreshCurrentTrip();
    toast("已刪除願望");
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
      if (window.liff.isInClient()) {
        window.liff.login({ redirectUri: location.href });
      }
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
    state.currentTrip = trip;
    toast(`已加入「${trip.title}」`);
  } catch (error) {
    console.warn(error);
  }
}

async function loadTrips() {
  const params = new URLSearchParams({ userId: state.user.lineUserId });
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
    toast("這個瀏覽器不支援定位");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      await loadRecommendations(true, {
        lat: String(position.coords.latitude),
        lng: String(position.coords.longitude)
      });
      renderRecommendations();
      toast("已更新附近推薦");
    },
    () => toast("定位沒有啟用，先用旅行地區推薦")
  );
}

function render() {
  renderUser();
  renderTripList();
  const hasTrip = Boolean(state.currentTrip);
  els.emptyState.hidden = hasTrip;
  els.tripView.hidden = !hasTrip;
  els.inviteButton.disabled = !hasTrip;
  if (!hasTrip) return;

  els.currentTripTitle.value = state.currentTrip.title;
  els.currentTripArea.value = state.currentTrip.area;
  renderStats();
  renderItinerary();
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
    els.tripList.innerHTML = `<p class="muted">還沒有旅行本</p>`;
    return;
  }
  els.tripList.innerHTML = state.trips
    .map(
      (trip) => `
        <button class="trip-link ${state.currentTrip?.id === trip.id ? "is-active" : ""}" type="button" data-trip-id="${escapeAttr(trip.id)}">
          <strong>${escapeHtml(trip.title)}</strong>
          <span>${escapeHtml(trip.area)} · ${trip.itinerary.length} 個行程 · ${trip.wishes.length} 個願望</span>
        </button>
      `
    )
    .join("");
}

function renderStats() {
  const trip = state.currentTrip;
  const budget = trip.itinerary.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const ticketTodo = trip.itinerary.filter((item) => item.ticketStatus === "needed").length;
  const reservationTodo = trip.itinerary.filter((item) => item.reservationStatus === "needed").length;
  els.tripStats.innerHTML = [
    stat("預估花費", money(budget)),
    stat("待購票", `${ticketTodo} 項`),
    stat("待訂位", `${reservationTodo} 項`),
    stat("同伴", `${trip.members.length} 人`)
  ].join("");
}

function renderItinerary() {
  const trip = state.currentTrip;
  const rows = trip.itinerary.length
    ? trip.itinerary.map((item) => itineraryRow(item)).join("")
    : `<p class="muted">還沒有行程</p>`;

  els.itineraryPanel.innerHTML = `
    <form class="item-form">
      <label>
        日期
        <input type="date" name="date" />
      </label>
      <label>
        時間
        <input type="time" name="time" />
      </label>
      <label>
        行程
        <input name="title" autocomplete="off" placeholder="幾米廣場" required />
      </label>
      <label>
        地點
        <input name="place" autocomplete="off" placeholder="宜蘭市" />
      </label>
      <label>
        是否購票
        <select name="ticketStatus">
          ${statusOptions("ticket", "none")}
        </select>
      </label>
      <label>
        是否訂位
        <select name="reservationStatus">
          ${statusOptions("reservation", "none")}
        </select>
      </label>
      <label>
        價格
        <input type="number" name="price" min="0" step="1" value="0" />
      </label>
      <label>
        幣別
        <input name="currency" value="TWD" />
      </label>
      <label class="full">
        備註
        <textarea name="note" placeholder="票券、訂位時間、集合點"></textarea>
      </label>
      <button class="primary-button full" type="submit">＋ 加入行程</button>
    </form>
    <div class="row-list">${rows}</div>
  `;
}

function itineraryRow(item) {
  return `
    <article class="data-row">
      <div class="row-title">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(formatWhen(item))}${item.place ? ` · ${escapeHtml(item.place)}` : ""}</small>
        ${item.note ? `<small>${escapeHtml(item.note)}</small>` : ""}
      </div>
      <span class="pill">${money(item.price || 0, item.currency)}</span>
      <select data-item-id="${escapeAttr(item.id)}" data-item-field="ticketStatus" aria-label="是否購票">
        ${statusOptions("ticket", item.ticketStatus)}
      </select>
      <select data-item-id="${escapeAttr(item.id)}" data-item-field="reservationStatus" aria-label="是否訂位">
        ${statusOptions("reservation", item.reservationStatus)}
      </select>
      <input type="number" min="0" step="1" value="${Number(item.price || 0)}" data-item-id="${escapeAttr(item.id)}" data-item-field="price" aria-label="價格" />
      <button class="danger-button" type="button" data-delete-item="${escapeAttr(item.id)}">刪除</button>
    </article>
  `;
}

function renderWishes() {
  const trip = state.currentTrip;
  const rows = trip.wishes.length ? trip.wishes.map((wish) => wishRow(wish)).join("") : `<p class="muted">還沒有願望</p>`;
  els.wishesPanel.innerHTML = `
    <form class="wish-form">
      <label>
        類型
        <select name="type">
          <option value="food">想吃</option>
          <option value="spot">想去</option>
          <option value="activity">想玩</option>
          <option value="other">其他</option>
        </select>
      </label>
      <label>
        願望
        <input name="text" autocomplete="off" placeholder="想吃甕窯雞" required />
      </label>
      <button class="primary-button" type="submit">＋ 許願</button>
    </form>
    <div class="row-list">${rows}</div>
  `;
}

function wishRow(wish) {
  return `
    <article class="data-row wish-row">
      <div class="row-title">
        <strong>${escapeHtml(wish.text)}</strong>
        <small>${wishTypeLabel(wish.type)} · ${escapeHtml(wish.author?.displayName || "旅伴")}</small>
      </div>
      <select data-wish-id="${escapeAttr(wish.id)}" data-wish-field="type" aria-label="願望類型">
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
    els.recommendationsPanel.innerHTML = `<p class="muted">載入附近推薦中</p>`;
    return;
  }

  els.recommendationsPanel.innerHTML = `
    <div class="recommendation-grid">
      <section class="recommendation-block">
        <div>
          <h3>${escapeHtml(rec.areaName)}玩法</h3>
          <button class="plain-button" type="button" data-use-location>⌖ 定位附近</button>
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
        <h3>常見吃法</h3>
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
        data-note="${escapeAttr(item.note)}">＋</button>
    </article>
  `;
}

function renderMembers() {
  const trip = state.currentTrip;
  els.membersPanel.innerHTML = `
    <div class="member-list">
      ${trip.members
        .map(
          (member) => `
            <article class="member-row">
              <strong>${escapeHtml(member.displayName)}</strong>
              <span class="muted">${member.role === "owner" ? "建立者" : "同伴"}</span>
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
  const text = `薛家好好玩邀請你一起規劃「${trip.title}」旅行日記：${url}`;

  if (
    window.liff &&
    state.liffReady &&
    typeof window.liff.shareTargetPicker === "function" &&
    window.liff.isApiAvailable("shareTargetPicker")
  ) {
    const result = await window.liff.shareTargetPicker([{ type: "text", text }]);
    toast(result ? "已送出邀請" : "已取消分享");
    return;
  }

  if (navigator.share) {
    await navigator.share({ title: "薛家好好玩", text, url });
    return;
  }

  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    toast("已複製邀請連結");
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

function stat(label, value) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function statusOptions(kind, selected) {
  const labels =
    kind === "ticket"
      ? { none: "免購票", needed: "待購票", done: "已購票" }
      : { none: "免訂位", needed: "待訂位", done: "已訂位" };
  return Object.entries(labels)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
    )
    .join("");
}

function wishTypeOptions(selected) {
  const labels = { food: "想吃", spot: "想去", activity: "想玩", other: "其他" };
  return Object.entries(labels)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
    )
    .join("");
}

function wishStatusOptions(selected) {
  const labels = { open: "許願中", planned: "已排入", done: "已完成" };
  return Object.entries(labels)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
    )
    .join("");
}

function wishTypeLabel(type) {
  return { food: "想吃", spot: "想去", activity: "想玩", other: "其他" }[type] || "其他";
}

function formatWhen(item) {
  const parts = [item.date, item.time].filter(Boolean);
  return parts.length ? parts.join(" ") : "未排時間";
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
  toast(error.message || "發生錯誤");
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

function cryptoRandom() {
  const array = new Uint32Array(2);
  crypto.getRandomValues(array);
  return Array.from(array, (part) => part.toString(16)).join("");
}

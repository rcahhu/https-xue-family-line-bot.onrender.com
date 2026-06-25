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
    toast("已儲存旅行日記");
  });

  els.tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    state.activeTab = tab.dataset.tab;
    renderPanels();
  });

  els.inviteButton.addEventListener("click", () => inviteCurrentTrip().catch(showError));

  els.itineraryPanel.addEventListener("submit", async (event) => {
    if (event.target.matches(".item-form")) {
      event.preventDefault();
      const item = formObject(event.target);
      await api(`/api/trips/${state.currentTrip.id}/itinerary`, {
        method: "POST",
        body: { actor: state.user, item }
      });
      event.target.reset();
      syncTypeFields(event.target);
      await refreshCurrentTrip();
      toast("已加入行程");
      return;
    }

    if (event.target.matches(".item-edit-form")) {
      event.preventDefault();
      const itemId = event.target.dataset.itemId;
      const patch = formObject(event.target);
      await api(`/api/trips/${state.currentTrip.id}/itinerary/${itemId}`, {
        method: "PATCH",
        body: { actor: state.user, patch }
      });
      await refreshCurrentTrip();
      toast("已更新行程");
    }
  });

  els.itineraryPanel.addEventListener("change", async (event) => {
    const typeSelect = event.target.closest(".item-type-select");
    if (typeSelect) {
      syncTypeFields(typeSelect.form);
      return;
    }

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
    const wish = formObject(event.target);
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
    els.tripList.innerHTML = `<p class="muted">還沒有旅行日記</p>`;
    return;
  }
  els.tripList.innerHTML = state.trips
    .map(
      (trip) => `
        <button class="trip-link ${state.currentTrip?.id === trip.id ? "is-active" : ""}" type="button" data-trip-id="${escapeAttr(trip.id)}">
          <strong>${escapeHtml(trip.title)}</strong>
          <span>${escapeHtml(trip.area)} · ${trip.itinerary.length} 個行程 · ${trip.members.length} 位同伴</span>
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
  const memberNames = trip.members.map((member) => member.displayName).join("、") || "尚無同伴";
  els.tripStats.innerHTML = [
    stat("預估花費", money(budget)),
    stat("行程規劃", `${trip.itinerary.length} 筆`),
    stat("搭車", `${transportCount} 筆`),
    stat("住宿", `${lodgingCount} 筆`),
    stat("同伴", `${trip.members.length} 人`),
    stat("同伴名單", memberNames),
    stat("最後修改", `${actorName(trip.updatedBy)} · ${formatDateTime(trip.updatedAt)}`)
  ].join("");
}

function renderItinerary() {
  const trip = state.currentTrip;
  const rows = trip.itinerary.length
    ? trip.itinerary.map((item) => itineraryRow(item)).join("")
    : `<p class="muted">還沒有行程規劃</p>`;

  els.itineraryPanel.innerHTML = `
    <form class="item-form">
      ${itineraryFields()}
      <button class="primary-button full" type="submit">＋ 加入行程</button>
    </form>
    <div class="row-list">${rows}</div>
  `;
  els.itineraryPanel.querySelectorAll(".item-form, .item-edit-form").forEach(syncTypeFields);
}

function itineraryFields(item = {}) {
  return `
    <label>
      類型
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
    <label>
      結束時間
      <input type="time" name="endTime" value="${escapeAttr(item.endTime || "")}" />
    </label>
    <label class="wide">
      行程名稱
      <input name="title" autocomplete="off" placeholder="羅東夜市、台鐵、住宿" value="${escapeAttr(item.title || "")}" required />
    </label>
    <label class="wide">
      地點
      <input name="place" autocomplete="off" placeholder="宜蘭、礁溪、羅東" value="${escapeAttr(item.place || "")}" />
    </label>
    <section class="type-fields type-transport full" data-type-fields="transport">
      <h3>搭車資訊</h3>
      <div class="field-grid">
        <label>
          交通工具
          <input name="transportMode" placeholder="台鐵、高鐵、客運、租車" value="${escapeAttr(item.transportMode || "")}" />
        </label>
        <label>
          車種/業者
          <input name="transportName" placeholder="自強號、葛瑪蘭客運" value="${escapeAttr(item.transportName || "")}" />
        </label>
        <label>
          車次/班次
          <input name="transportNumber" placeholder="123、1915" value="${escapeAttr(item.transportNumber || "")}" />
        </label>
        <label>
          哪裡到哪裡
          <input name="fromPlace" placeholder="台北車站" value="${escapeAttr(item.fromPlace || "")}" />
        </label>
        <label>
          抵達地
          <input name="toPlace" placeholder="宜蘭車站" value="${escapeAttr(item.toPlace || "")}" />
        </label>
        <label>
          在哪裡坐
          <input name="boardingPlace" placeholder="台北轉運站 4 號月台" value="${escapeAttr(item.boardingPlace || "")}" />
        </label>
        <label>
          時長
          <input name="duration" placeholder="1 小時 20 分" value="${escapeAttr(item.duration || "")}" />
        </label>
      </div>
    </section>
    <section class="type-fields type-lodging full" data-type-fields="lodging">
      <h3>住宿資訊</h3>
      <div class="field-grid">
        <label>
          住哪
          <input name="lodgingName" placeholder="飯店 / 民宿名稱" value="${escapeAttr(item.lodgingName || "")}" />
        </label>
        <label>
          地址
          <input name="lodgingAddress" placeholder="住宿地址" value="${escapeAttr(item.lodgingAddress || "")}" />
        </label>
        <label>
          入住日
          <input type="date" name="checkInDate" value="${escapeAttr(item.checkInDate || "")}" />
        </label>
        <label>
          退房日
          <input type="date" name="checkOutDate" value="${escapeAttr(item.checkOutDate || "")}" />
        </label>
        <label>
          早餐
          <select name="breakfast">
            ${selectOptions(
              { unknown: "未確認", included: "有早餐", not_included: "沒有早餐" },
              item.breakfast || "unknown"
            )}
          </select>
        </label>
        <label>
          訂房編號
          <input name="confirmationNumber" placeholder="訂房平台或確認碼" value="${escapeAttr(item.confirmationNumber || "")}" />
        </label>
      </div>
    </section>
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
    <label>
      價格
      <input type="number" name="price" min="0" step="1" value="${Number(item.price || 0)}" />
    </label>
    <label>
      幣別
      <input name="currency" value="${escapeAttr(item.currency || "TWD")}" />
    </label>
    <label class="full">
      備註
      <textarea name="note" placeholder="票券、訂位時間、集合點">${escapeHtml(item.note || "")}</textarea>
    </label>
  `;
}

function itineraryRow(item) {
  return `
    <article class="data-row itinerary-row">
      <div class="row-title">
        <div class="title-line">
          <span class="type-badge">${itineraryTypeLabel(item.type)}</span>
          <strong>${escapeHtml(item.title)}</strong>
        </div>
        <small>${escapeHtml(formatWhen(item))}${item.place ? ` · ${escapeHtml(item.place)}` : ""}</small>
        ${itineraryDetail(item)}
        ${item.note ? `<small>備註：${escapeHtml(item.note)}</small>` : ""}
        <small class="audit-line">${auditLine(item)}</small>
      </div>
      <div class="row-controls">
        <span class="pill">${money(item.price || 0, item.currency)}</span>
        <select data-item-id="${escapeAttr(item.id)}" data-item-field="ticketStatus" aria-label="是否購票">
          ${statusOptions("ticket", item.ticketStatus)}
        </select>
        <select data-item-id="${escapeAttr(item.id)}" data-item-field="reservationStatus" aria-label="是否訂位">
          ${statusOptions("reservation", item.reservationStatus)}
        </select>
        <input type="number" min="0" step="1" value="${Number(item.price || 0)}" data-item-id="${escapeAttr(item.id)}" data-item-field="price" aria-label="價格" />
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

function itineraryDetail(item) {
  if (item.type === "transport") {
    const details = [
      joinParts([item.transportMode, item.transportName, item.transportNumber], " "),
      joinParts([item.fromPlace, item.toPlace], " → "),
      item.boardingPlace ? `在哪坐：${item.boardingPlace}` : "",
      item.duration ? `時長：${item.duration}` : ""
    ].filter(Boolean);
    return details.length ? `<small>搭車：${escapeHtml(details.join(" · "))}</small>` : "";
  }

  if (item.type === "lodging") {
    const details = [
      item.lodgingName ? `住哪：${item.lodgingName}` : "",
      item.lodgingAddress ? `地址：${item.lodgingAddress}` : "",
      item.checkInDate || item.checkOutDate
        ? `入住/退房：${item.checkInDate || "未填"} → ${item.checkOutDate || "未填"}`
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
    : `<p class="muted">還沒有願望</p>`;
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
        <small>${wishTypeLabel(wish.type)} · ${escapeHtml(actorName(wish.author))}</small>
        <small class="audit-line">${auditLine(wish)}</small>
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
    <div class="member-summary">
      <strong>同伴 ${trip.members.length} 人</strong>
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

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
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
      ? { none: "免購票", needed: "待購票", done: "已購票" }
      : { none: "免訂位", needed: "待訂位", done: "已訂位" };
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
  const labels = { open: "許願中", planned: "已排入", done: "已完成" };
  return selectOptions(labels, selected);
}

function wishTypeLabel(type) {
  return { food: "想吃", spot: "想去", activity: "想玩", other: "其他" }[type] || "其他";
}

function itineraryTypeLabel(type) {
  return { activity: "行程", transport: "搭車", lodging: "住宿" }[type] || "行程";
}

function breakfastLabel(value) {
  return { unknown: "未確認", included: "有早餐", not_included: "沒有早餐" }[value] || "未確認";
}

function formatWhen(item) {
  if (item.type === "lodging" && (item.checkInDate || item.checkOutDate)) {
    return `${item.checkInDate || "未填入住日"} → ${item.checkOutDate || "未填退房日"}`;
  }
  const start = [item.date, item.time].filter(Boolean).join(" ");
  const end = item.endTime ? ` → ${item.endTime}` : "";
  return start ? `${start}${end}` : "未排時間";
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
  return `新增：${actorName(entry.createdBy)} ${formatDateTime(entry.createdAt)}｜最後修改：${actorName(entry.updatedBy)} ${formatDateTime(entry.updatedAt)}`;
}

function actorName(actor) {
  return actor?.displayName || actor?.name || "旅伴";
}

function joinParts(parts, separator) {
  return parts.filter(Boolean).join(separator);
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

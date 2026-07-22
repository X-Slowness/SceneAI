const SETTINGS_KEY = "greenroom.settings.v1";

const confirmDialog = document.getElementById("confirmDialog");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOk = document.getElementById("confirmOk");
const confirmCancel = document.getElementById("confirmCancel");

function showConfirm(message) {
  return new Promise(resolve => {
    confirmMessage.textContent = message;
    confirmDialog.showModal();
    const cleanup = (result) => {
      confirmDialog.close();
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
  });
}

let currentUser = null;
const earlySaved = localStorage.getItem("sceneai_user");
if (earlySaved) {
  try { currentUser = JSON.parse(earlySaved); } catch(e) { localStorage.removeItem("sceneai_user"); }
}

const ALL_TAGS = [
  "Male", "Female", "Male POV", "Female POV",
  "Romantic", "Drama", "Action", "Adventure",
  "Fantasy", "Isekai", "Multiple Characters", "Friend",
  "Scenario", "Cheating", "Comedy", "Gothic",
  "Villain", "Married", "Roommate", "Chubby",
  "Girlfriend", "Boyfriend", "Enemy", "Gang", "Crush", "Travel", "Streamer", "Anime", "Real Life", "Game", "Single"
];

function fallbackAvatar(name, color) {
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <rect width="200" height="200" fill="${color}"/>
    <text x="100" y="112" font-family="Inter, sans-serif" font-size="72" font-weight="600"
      fill="#241a05" text-anchor="middle">${initials}</text>
  </svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}

async function loadCharacters() {
  try {
    const url = currentUser ? `/api/characters?userId=${currentUser.id}` : "/api/characters";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load characters");
    return await res.json();
  } catch(e) {
    console.error("loadCharacters failed:", e);
    return [];
  }
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (currentUser) h["X-User-Id"] = currentUser.id;
  return h;
}

function requireAuth() {
  if (currentUser) return true;
  document.getElementById("signInRequiredModal").showModal();
  return false;
}

function showAlert(title, msg) {
  document.getElementById("alertModalTitle").textContent = title;
  document.getElementById("alertModalMsg").textContent = msg;
  document.getElementById("alertModal").showModal();
}

async function checkAdmin() {
  if (!currentUser) { isAdmin = false; return; }
  try {
    const res = await fetch(`/api/admin/check?userId=${currentUser.id}`);
    const data = await res.json();
    isAdmin = data.admin;
  } catch(e) { isAdmin = false; }
}

async function checkSubscription() {
  if (!currentUser) { isSubscriber = false; longerMessages = false; return; }
  try {
    const res = await fetch(`/api/subscription/status?userId=${currentUser.id}`);
    const data = await res.json();
    isSubscriber = data.tier === "subscriber" || isAdmin;
    longerMessages = data.longer_messages || false;
  } catch(e) { isSubscriber = isAdmin; longerMessages = false; }
}

function applyAdminUI() {
  const newBtn = document.getElementById("newCharacterBtn");
  if (newBtn) newBtn.style.display = currentUser ? "" : "none";
  const aiBtn = document.getElementById("aiGenBtn");
  if (aiBtn) aiBtn.style.display = isAdmin ? "" : "none";
  document.querySelectorAll(".card-edit").forEach(el => {
    el.style.display = isAdmin ? "" : "none";
  });
  document.querySelectorAll(".card-details").forEach(el => {
    el.style.display = isAdmin ? "none" : "flex";
  });
  favoritesBtn.style.display = currentUser ? "" : "none";
  groupChatsBtn.style.display = currentUser ? "" : "none";
  if (!currentUser && !galleryView.hidden) {
    showGallery();
  }
  updateCreateBtnBadge();
}

let coinInfo = { coins: 0, free_remaining: 10, is_subscriber: false };
async function fetchCoinInfo() {
  if (!currentUser) {
    document.getElementById("coinBadge").style.display = "none";
    return;
  }
  try {
    const res = await fetch(`/api/coins/${currentUser.id}?_t=${Date.now()}`);
    if (res.ok) coinInfo = await res.json();
  } catch(e) {}
  const coinBadge = document.getElementById("coinBadge");
  const coinCount = document.getElementById("coinCount");
  if (coinBadge && coinCount) {
    coinBadge.style.display = "flex";
    coinCount.textContent = coinInfo.coins || 0;
  }
}
function updateCreateBtnBadge() {
  fetchCoinInfo().then(() => {
    const newBtn = document.getElementById("newCharacterBtn");
    if (!newBtn) return;
    let badge = newBtn.querySelector(".create-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "create-badge";
      newBtn.appendChild(badge);
    }
    if (coinInfo.is_admin) {
      badge.textContent = "ADMIN";
      badge.style.background = "#6b3fa0";
    } else if (coinInfo.is_subscriber) {
      badge.textContent = "PRO";
      badge.style.background = "var(--accent-bright)";
    } else if (coinInfo.free_remaining > 0) {
      badge.textContent = coinInfo.free_remaining + " free left";
      badge.style.background = "var(--accent-bright)";
    } else {
      badge.textContent = coinInfo.coins + " coins";
      badge.style.background = coinInfo.coins >= 200 ? "#22c55e" : "#ef4444";
    }
  });
}

// ── Daily Login Streak ────────────────────────────────────
const REWARDS = [0, 50, 100, 150, 200, 250, 300, 350];
const dailyRewardModal = document.getElementById("dailyRewardModal");
const dailyStreakTrack = document.getElementById("dailyStreakTrack");
const dailyRewardMsg = document.getElementById("dailyRewardMsg");
const dailyRewardSubtitle = document.getElementById("dailyRewardSubtitle");
const claimDailyBtn = document.getElementById("claimDailyRewardBtn");
const closeDailyBtn = document.getElementById("closeDailyRewardBtn");

function renderStreakDays(currentDay, claimedToday) {
  dailyStreakTrack.innerHTML = "";
  for (let i = 1; i <= 7; i++) {
    const isClaimed = claimedToday && i <= currentDay;
    const isNext = !claimedToday && i === currentDay;
    const el = document.createElement("div");
    el.className = "streak-node" + (isClaimed ? " claimed" : "") + (isNext ? " next" : "");
    const size = 32 + (i * 4);
    const reward = REWARDS[i];
    el.innerHTML = `
      <div class="node-ring" style="width:${size}px;height:${size}px;">
        ${isClaimed ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : `<span class="node-coin-icon">${reward}</span>`}
      </div>
      <span class="node-label">Day ${i}</span>
    `;
    if (i < 7) {
      const line = document.createElement("div");
      line.className = "streak-line" + (isClaimed ? " filled" : "");
      dailyStreakTrack.appendChild(el);
      dailyStreakTrack.appendChild(line);
    } else {
      dailyStreakTrack.appendChild(el);
    }
  }
}

async function checkDailyReward() {
  if (!currentUser) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const res = await fetch(`/api/daily-reward/${currentUser.id}?tz=${encodeURIComponent(tz)}`);
    const data = await res.json();
    if (data.claimable) {
      renderStreakDays(data.streak_day, false);
      dailyRewardMsg.textContent = `Log in tomorrow for Day ${data.streak_day + 1 > 7 ? 1 : data.streak_day + 1} — ${REWARDS[data.streak_day + 1 > 7 ? 1 : data.streak_day + 1]} coins!`;
      dailyRewardSubtitle.textContent = `Day ${data.streak_day} of 7`;
      claimDailyBtn.textContent = `Claim +${data.reward}`;
      claimDailyBtn.style.display = "";
      dailyRewardModal.showModal();
    }
  } catch(e) {}
}

claimDailyBtn.addEventListener("click", async () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const res = await fetch("/api/daily-reward/claim", {
      method: "POST",
      headers: { ...authHeaders(), "X-Timezone": tz }
    });
    const data = await res.json();
    if (data.ok) {
      renderStreakDays(data.streak_day, true);
      dailyRewardMsg.textContent = `+${data.reward} coins! Total: ${data.total_coins}`;
      claimDailyBtn.style.display = "none";
      coinInfo.coins = data.total_coins;
      const coinCount = document.getElementById("coinCount");
      if (coinCount) coinCount.textContent = data.total_coins;
      updateCreateBtnBadge();
    }
  } catch(e) {}
});

closeDailyBtn.addEventListener("click", () => { dailyRewardModal.close(); fetchCoinInfo(); });
dailyRewardModal.addEventListener("click", (e) => { if (e.target === dailyRewardModal) { dailyRewardModal.close(); fetchCoinInfo(); } });

document.getElementById("dailyRewardBtn").addEventListener("click", async () => {
  if (!currentUser) { document.getElementById("signInRequiredModal").showModal(); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const res = await fetch(`/api/daily-reward/${currentUser.id}?tz=${encodeURIComponent(tz)}`);
    const data = await res.json();
    if (data.claimable) {
      renderStreakDays(data.streak_day, false);
      dailyRewardMsg.textContent = `Log in tomorrow for Day ${data.streak_day + 1 > 7 ? 1 : data.streak_day + 1} — ${REWARDS[data.streak_day + 1 > 7 ? 1 : data.streak_day + 1]} coins!`;
      dailyRewardSubtitle.textContent = `Day ${data.streak_day} of 7`;
      claimDailyBtn.textContent = `Claim +${data.reward}`;
      claimDailyBtn.style.display = "";
    } else if (data.admin) {
      renderStreakDays(7, true);
      dailyRewardMsg.textContent = "Admin — unlimited access!";
      dailyRewardSubtitle.textContent = "All rewards unlocked";
      claimDailyBtn.style.display = "none";
    } else {
      renderStreakDays(data.streak_day, true);
      dailyRewardMsg.textContent = "Already claimed today! Come back tomorrow.";
      dailyRewardSubtitle.textContent = `Day ${data.streak_day} of 7`;
      claimDailyBtn.style.display = "none";
    }
    dailyRewardModal.showModal();
  } catch(e) {}
});

// ── Buy Coins ─────────────────────────────────────────────
const buyCoinsModal = document.getElementById("buyCoinsModal");
const closeBuyCoinsBtn = document.getElementById("closeBuyCoinsBtn");

document.getElementById("buyCoinsBtn").addEventListener("click", () => {
  if (!currentUser) { document.getElementById("signInRequiredModal").showModal(); return; }
  buyCoinsModal.showModal();
});
closeBuyCoinsBtn.addEventListener("click", () => buyCoinsModal.close());
buyCoinsModal.addEventListener("click", (e) => { if (e.target === buyCoinsModal) buyCoinsModal.close(); });
buyCoinsModal.addEventListener("close", () => { buyCoinsModal.querySelector(".buy-coins-title").textContent = "Buy Coins"; });

document.querySelectorAll(".coin-package").forEach(btn => {
  btn.addEventListener("click", async () => {
    const variantId = parseInt(btn.dataset.variant);
    try {
      const res = await fetch("/api/coins/checkout", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ variantId })
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        showAlert("Error", data.error || "Failed to start checkout.");
      }
    } catch(e) {
      showAlert("Error", "Failed to start checkout.");
    }
  });
});

async function createCharacter(data) {
  const res = await fetch("/api/characters", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to create character");
  }
  return await res.json();
}

async function updateCharacter(id, data) {
  const res = await fetch(`/api/characters/${id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(data)
  });
  if (res.status === 403) throw new Error("Permission denied");
  if (!res.ok) throw new Error("Failed to update character");
  return await res.json();
}

async function deleteCharacter(id) {
  const res = await fetch(`/api/characters/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to delete character");
}

async function likeCharacter(id) {
  const res = await fetch(`/api/characters/${id}/like`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to like character");
  return await res.json();
}

async function unlikeCharacter(id) {
  const res = await fetch(`/api/characters/${id}/like`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to unlike character");
  return await res.json();
}

async function loadMessages(characterId) {
  if (!currentUser) return [];
  try {
    const res = await fetch(`/api/characters/${characterId}/messages?userId=${currentUser.id}`);
    if (!res.ok) throw new Error("Failed to load messages");
    return await res.json();
  } catch(e) {
    console.error("loadMessages failed:", e);
    return [];
  }
}

async function saveMessages(characterId, messages) {
  if (!currentUser) return;
  const res = await fetch(`/api/characters/${characterId}/messages`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: currentUser.id, messages })
  });
  if (!res.ok) throw new Error("Failed to save messages");
}

async function addMessage(characterId, role, content, ts) {
  if (!currentUser) return;
  await fetch(`/api/characters/${characterId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: currentUser.id, role, content, ts: ts || Date.now() })
  });
}

function getSettingsKey() {
  const id = currentUser ? currentUser.id : "guest";
  return `greenroom.settings.v1.${id}`;
}

function loadSettings() {
  const raw = localStorage.getItem(getSettingsKey());
  if (raw) return JSON.parse(raw);
  return { theme: "dark", msgColor: "#c9952c" };
}

function saveSettings(s) {
  localStorage.setItem(getSettingsKey(), JSON.stringify(s));
}

let settings = loadSettings();

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
}

function applyMsgColor(color) {
  document.body.style.setProperty("--user-msg", color);
  const selected = document.querySelector(`.color-swatch[data-color="${color}"]`);
  document.querySelectorAll(".color-swatch").forEach(s => s.style.borderColor = "transparent");
  if (selected) selected.style.borderColor = "#fff";
}

let chatThemes = [];
let activeChatTheme = settings.chatTheme || "default";

function removeGalaxyStars() {
  const old = document.querySelector(".galaxy-stars");
  if (old) old.remove();
}
function injectGalaxyStars() {
  removeGalaxyStars();
  const chatView = document.getElementById("chatView");
  if (!chatView || chatView.hidden) return;
  const container = document.createElement("div");
  container.className = "galaxy-stars";
  const stars = [
    { x: 3, y: 8, s: 10, c: "", d: "A" },
    { x: 11, y: 42, s: 8, c: "purple", d: "B" },
    { x: 19, y: 72, s: 10, c: "", d: "A" },
    { x: 27, y: 18, s: 12, c: "bright", d: "B" },
    { x: 34, y: 55, s: 10, c: "", d: "A" },
    { x: 42, y: 88, s: 8, c: "purple", d: "B" },
    { x: 50, y: 28, s: 12, c: "", d: "A" },
    { x: 57, y: 62, s: 10, c: "bright", d: "B" },
    { x: 64, y: 5, s: 10, c: "", d: "A" },
    { x: 71, y: 48, s: 8, c: "purple", d: "B" },
    { x: 78, y: 82, s: 12, c: "", d: "A" },
    { x: 85, y: 35, s: 10, c: "bright", d: "B" },
    { x: 92, y: 68, s: 10, c: "", d: "A" },
    { x: 6, y: 92, s: 8, c: "purple", d: "B" },
    { x: 23, y: 30, s: 12, c: "", d: "A" },
    { x: 38, y: 78, s: 10, c: "bright", d: "B" },
    { x: 53, y: 12, s: 10, c: "", d: "A" },
    { x: 67, y: 58, s: 8, c: "purple", d: "B" },
    { x: 82, y: 15, s: 12, c: "", d: "A" },
    { x: 96, y: 52, s: 10, c: "bright", d: "B" }
  ];
  stars.forEach(s => {
    const el = document.createElement("div");
    el.className = "galaxy-star" + (s.c ? " " + s.c : "");
    el.style.cssText = `left:${s.x}%;top:${s.y}%;width:${s.s}px;height:${s.s}px;animation:galaxyBlink${s.d} ${3 + Math.random() * 3}s ease-in-out infinite;animation-delay:${Math.random() * 2}s;`;
    container.appendChild(el);
  });
  chatView.prepend(container);
}
function applyChatTheme(themeId) {
  document.body.style.removeProperty("--user-msg");
  document.body.classList.remove("theme-midnight", "theme-ocean", "theme-sunset", "theme-forest", "theme-rose", "theme-neon", "theme-cherry", "theme-galaxy");
  removeGalaxyStars();
  if (themeId && themeId !== "default") {
    document.body.classList.add("theme-" + themeId);
  }
  activeChatTheme = themeId;
  settings.chatTheme = themeId;
  saveSettings(settings);
  applyMsgColor(settings.msgColor || "#c9952c");
  if (currentUser) {
    fetch("/api/themes/set", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": currentUser.id },
      body: JSON.stringify({ themeId })
    }).catch(() => {});
  }
  updateThemeGridUI();
}

async function fetchAndRenderThemes() {
  if (!currentUser) return;
  try {
    const res = await fetch(`/api/themes?userId=${currentUser.id}&_t=${Date.now()}`);
    const data = await res.json();
    chatThemes = data.themes || [];
    activeChatTheme = data.active || "default";
    settings.chatTheme = activeChatTheme;
    if (data.msg_color && data.msg_color !== settings.msgColor) {
      settings.msgColor = data.msg_color;
      applyMsgColor(data.msg_color);
    }
    saveSettings(settings);
    applyChatTheme(activeChatTheme);
    renderThemeGrid();
  } catch (e) {
    console.error("Failed to load themes:", e);
  }
}

function renderThemeGrid() {
  const grid = document.getElementById("themesGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const t of chatThemes) {
    const card = document.createElement("div");
    card.className = "theme-card" + (t.id === activeChatTheme ? " active" : "") + (t.owned ? " owned" : "");
    const preview = getThemePreviewColors(t.id);
    card.innerHTML = `
      <div class="theme-card-preview" style="background:${preview.bg}">
        <div class="mini-bubble user" style="background:${preview.user}"></div>
        <div class="mini-bubble char" style="background:${preview.char};border:1px solid ${preview.border}"></div>
      </div>
      <div class="theme-card-info">
        <div class="theme-card-name">${t.name}</div>
        ${t.id === activeChatTheme ? '<div class="theme-card-buy" style="color:var(--accent-bright)">Equipped</div>' :
          t.owned ? '<div class="theme-card-buy" style="color:var(--accent)">Owned</div>' :
          t.price === 0 ? '<div class="theme-card-buy">Free</div>' :
          `<div class="theme-card-buy">${t.price} coins</div>`}
      </div>`;
    card.addEventListener("click", () => handleThemeClick(t));
    grid.appendChild(card);
  }
}

function updateThemeGridUI() {
  document.querySelectorAll(".theme-card").forEach(card => {
    const name = card.querySelector(".theme-card-name");
    if (!name) return;
    const theme = chatThemes.find(t => t.name === name.textContent);
    if (!theme) return;
    card.classList.toggle("active", theme.id === activeChatTheme);
    const info = card.querySelector(".theme-card-info > :last-child");
    if (info) {
      if (theme.id === activeChatTheme) {
        info.className = "theme-card-buy";
        info.style.color = "var(--accent-bright)";
        info.textContent = "Equipped";
      } else if (theme.owned) {
        info.className = "theme-card-buy";
        info.textContent = "Owned";
        info.style.color = "var(--accent)";
      }
    }
  });
}

function getThemePreviewColors(id) {
  const map = {
    default: { bg: "#0f0e11", user: "#c9952c", char: "#1e1b22", border: "#2a2530" },
    midnight: { bg: "#12101f", user: "#8b5cf6", char: "#221e35", border: "#2e2850" },
    ocean: { bg: "#0e1a28", user: "#3b82f6", char: "#1a3050", border: "#254065" },
    sunset: { bg: "#221210", user: "#f97316", char: "#402018", border: "#503020" },
    forest: { bg: "#0e2214", user: "#22c55e", char: "#1c4028", border: "#285035" },
    rose: { bg: "#22101c", user: "#ec4899", char: "#401835", border: "#552045" },
    neon: { bg: "#10101e", user: "#00ff88", char: "#252545", border: "#303055" },
    cherry: { bg: "#220e18", user: "#dc2626", char: "#3a1828", border: "#4a2038" },
    galaxy: { bg: "#100c22", user: "#a855f7", char: "#201845", border: "#302555" }
  };
  return map[id] || map.default;
}

async function handleThemeClick(t) {
  if (t.id === activeChatTheme) return;
  if (t.owned || t.price === 0) {
    applyChatTheme(t.id);
    return;
  }
  const isSub = coinInfo.is_subscriber || (typeof isAdmin !== "undefined" && isAdmin);
  if (coinInfo.coins < t.price) {
    const modal = document.getElementById("buyCoinsModal");
    const title = modal.querySelector(".buy-coins-title");
    if (title) title.textContent = "Not Enough Coins";
    modal.showModal();
    return;
  }
  if (!(await showConfirm(`Buy "${t.name}" theme for ${t.price} coins?`))) return;
  try {
    const res = await fetch("/api/themes/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": currentUser.id },
      body: JSON.stringify({ themeId: t.id })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || "Failed to buy theme"); return; }
    coinInfo.coins = data.coins;
    document.getElementById("coinCount").textContent = coinInfo.coins.toLocaleString();
    t.owned = true;
    applyChatTheme(t.id);
  } catch (e) {
    alert("Failed to buy theme.");
  }
}

applyTheme(settings.theme);
applyMsgColor(settings.msgColor || "#c9952c");
applyChatTheme(settings.chatTheme || "default");

// ── Cross-device sync: re-fetch theme + msg color on focus/visibility ──
async function syncThemeFromServer() {
  if (!currentUser) return;
  try {
    const r = await fetch(`/api/themes?userId=${currentUser.id}&_t=${Date.now()}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.active && d.active !== activeChatTheme) {
      activeChatTheme = d.active;
      settings.chatTheme = d.active;
      applyChatTheme(d.active);
    }
    if (d.msg_color && d.msg_color !== settings.msgColor) {
      settings.msgColor = d.msg_color;
      applyMsgColor(d.msg_color);
    }
  } catch(e) {}
}
// On page load: show immediately with localStorage theme, then silently sync from server
if (currentUser) {
  syncThemeFromServer();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncThemeFromServer(); });
window.addEventListener("focus", syncThemeFromServer);
setInterval(syncThemeFromServer, 30000);

// ── Favorites ─────────────────────────────────────────────
async function favoriteCharacter(id) {
  const res = await fetch(`/api/characters/${id}/favorite`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to favorite character");
  return await res.json();
}

async function unfavoriteCharacter(id) {
  const res = await fetch(`/api/characters/${id}/favorite`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to unfavorite character");
  return await res.json();
}

// ── Memories ──────────────────────────────────────────────
async function loadMemories(characterId) {
  if (!currentUser) return [];
  try {
    const res = await fetch(`/api/characters/${characterId}/memories?userId=${currentUser.id}`);
    if (!res.ok) throw new Error("Failed to load memories");
    return await res.json();
  } catch(e) {
    console.error("loadMemories failed:", e);
    return [];
  }
}

async function addMemory(characterId, content) {
  if (!currentUser) return;
  const res = await fetch(`/api/characters/${characterId}/memories`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error("Failed to add memory");
  return await res.json();
}

async function deleteMemory(characterId, memoryId) {
  if (!currentUser) return;
  const res = await fetch(`/api/characters/${characterId}/memories/${memoryId}`, {
    method: "DELETE",
    headers: authHeaders()
  });
  if (!res.ok) throw new Error("Failed to delete memory");
  return await res.json();
}

function avatarSrc(c) {
  return c.photo || fallbackAvatar(c.name, c.color);
}

function avatarStyle(c) {
  let style = "";
  if (c.photo && c.photo_pos != null) style += `object-position:50% ${c.photo_pos}%;`;
  const zoom = c.photo && c.photo_zoom != null ? c.photo_zoom : 1;
  if (zoom < 1) {
    style += `object-fit:contain;`;
  } else if (zoom !== 1) {
    style += `transform:scale(${zoom});`;
  }
  return style;
}

let characters = [];
let activeId = null;
let editingId = null;
let selectedTags = [];
let isAdmin = false;
let isSubscriber = false;
let longerMessages = false;

const galleryView = document.getElementById("galleryView");
const recentChatsView = document.getElementById("recentChatsView");
const favoritesView = document.getElementById("favoritesView");
const trendingView = document.getElementById("trendingView");
const mostLikedView = document.getElementById("mostLikedView");
const myCharactersView = document.getElementById("myCharactersView");
const chatView = document.getElementById("chatView");
const galleryEl = document.getElementById("gallery");
const recentChatsGalleryEl = document.getElementById("recentChatsGallery");
const favoritesGalleryEl = document.getElementById("favoritesGallery");
const trendingGalleryEl = document.getElementById("trendingGallery");
const mostLikedGalleryEl = document.getElementById("mostLikedGallery");
const myCharactersGalleryEl = document.getElementById("myCharactersGallery");
const questsView = document.getElementById("questsView");
const questsContentEl = document.getElementById("questsContent");
const homeNavBtn = document.getElementById("homeNavBtn");
const recentChatsBtn = document.getElementById("recentChatsBtn");
const favoritesBtn = document.getElementById("favoritesBtn");
const myCharactersBtn = document.getElementById("myCharactersBtn");
const questsBtn = document.getElementById("questsBtn");
const trendingBtn = document.getElementById("trendingBtn");
const mostLikedBtn = document.getElementById("mostLikedBtn");

const messagesEl = document.getElementById("messages");
const activeNameEl = document.getElementById("activeName");
const activeTaglineEl = document.getElementById("activeTagline");
const activeAvatarEl = document.getElementById("activeAvatar");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const backBtn = document.getElementById("backBtn");

const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const filterTagsEl = document.getElementById("filterTags");

const modal = document.getElementById("characterModal");
const modalTitle = document.getElementById("modalTitle");
const characterForm = document.getElementById("characterForm");
const photoInput = document.getElementById("charPhoto");
const photoPreview = document.getElementById("photoPreview");
const nameInput = document.getElementById("charName");
const taglineInput = document.getElementById("charTagline");
const personaInput = document.getElementById("charPersona");
const colorInput = document.getElementById("charColor");
const tagsContainer = document.getElementById("tagsContainer");
const firstMsgInput = document.getElementById("charFirstMsg");
const deleteCharacterBtn = document.getElementById("deleteCharacter");

let pendingPhoto = null;
let pendingPhotoPos = 50;
let pendingPhotoZoom = 1.0;
let filterSearchText = "";
let filterActiveTags = [];
let currentPage = 1;

function getFilteredCharacters() {
  let list = characters;
  if (filterSearchText.trim()) {
    const q = filterSearchText.trim().toLowerCase();
    list = list.filter(c => c.name.toLowerCase().includes(q));
  }
  if (filterActiveTags.length > 0) {
    list = list.filter(c => {
      const ctags = c.tags || [];
      return filterActiveTags.every(t => ctags.includes(t));
    });
  }
  return list;
}

function renderFilterTags() {
  filterTagsEl.innerHTML = "";
  ALL_TAGS.forEach(tag => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-tag" + (filterActiveTags.includes(tag) ? " active" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      const idx = filterActiveTags.indexOf(tag);
      if (idx > -1) filterActiveTags.splice(idx, 1);
      else filterActiveTags.push(tag);
      applyFilters();
    });
    filterTagsEl.appendChild(chip);
  });
}

function applyFilters() {
  currentPage = 1;
  renderFilterTags();
  runFilteredGallery();
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function runFilteredGallery() {
  const ITEMS_PER_PAGE = 12;
  const filtered = getFilteredCharacters();
  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const items = filtered.slice(start, start + ITEMS_PER_PAGE);
  galleryEl.innerHTML = "";
  if (items.length === 0) {
    galleryEl.innerHTML = `<p class="card-desc" style="text-align:center;padding:40px 0;">No characters found.</p>`;
  } else {
    items.forEach(c => galleryEl.appendChild(buildCard(c)));
  }
  renderFilterPagination(totalPages);
}

function renderTagChips(container, selected) {
  container.innerHTML = "";
  ALL_TAGS.forEach(tag => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip" + (selected.includes(tag) ? " selected" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      const idx = selected.indexOf(tag);
      if (idx > -1) selected.splice(idx, 1);
      else selected.push(tag);
      renderTagChips(container, selected);
    });
    container.appendChild(chip);
  });
}

async function openCreateModal() {
  if (!currentUser) {
    document.getElementById("signInRequiredModal").showModal();
    return;
  }
  editingId = null;
  modalTitle.textContent = "Create Character";
  characterForm.reset();
  colorInput.value = "#e2b04a";
  pendingPhoto = null;
  pendingPhotoPos = 50;
  pendingPhotoZoom = 1.0;
  updatePhotoButton();
  selectedTags = [];
  renderTagChips(tagsContainer, selectedTags);
  deleteCharacterBtn.style.display = "none";
  modal.showModal();
}

function openEditModal(c) {
  editingId = c.id;
  modalTitle.textContent = "Edit Character";
  nameInput.value = c.name;
  taglineInput.value = c.tagline || "";
  personaInput.value = c.persona;
  firstMsgInput.value = c.first_message || "";
  colorInput.value = c.color;
  pendingPhoto = c.photo || null;
  pendingPhotoPos = c.photo_pos != null ? c.photo_pos : 50;
  pendingPhotoZoom = c.photo_zoom != null ? c.photo_zoom : 1.0;
  updatePhotoButton();
  selectedTags = [...(c.tags || [])];
  renderTagChips(tagsContainer, selectedTags);
  const canDelete = currentUser && (isAdmin || c.created_by === currentUser.id);
  deleteCharacterBtn.style.display = canDelete ? "" : "none";
  modal.showModal();
}

document.getElementById("newCharacterBtn").addEventListener("click", openCreateModal);
document.getElementById("cancelCharacter").addEventListener("click", () => modal.close());
deleteCharacterBtn.addEventListener("click", async () => {
  if (!editingId) return;
  const c = characters.find(x => x.id === editingId);
  const charName = c ? c.name : "this character";
  if (!(await showConfirm(`Delete "${charName}"?\n\nThis will permanently remove the character, all messages, likes, favorites, and memories. This cannot be undone.`))) return;
  try {
    await fetch(`/api/characters/${editingId}`, { method: "DELETE", headers: { "x-user-id": currentUser?.id || "" } });
    editingId = null;
    modal.close();
    await refreshCharacters();
    showGallery();
  } catch(e) {
    console.error("Delete character failed:", e);
    showAlert("Error", "Failed to delete character.");
  }
});

// ── AI Character Generator ────────────────────────────────
const aiGenModal = document.getElementById("aiGenModal");
const aiGenConcept = document.getElementById("aiGenConcept");
const aiGenLoading = document.getElementById("aiGenLoading");
const aiGenResult = document.getElementById("aiGenResult");
const aiGenGenerateBtn = document.getElementById("aiGenGenerateBtn");
const aiGenUseBtn = document.getElementById("aiGenUseBtn");

document.getElementById("aiGenBtn").addEventListener("click", () => {
  aiGenConcept.value = "";
  aiGenLoading.style.display = "none";
  aiGenResult.style.display = "none";
  aiGenGenerateBtn.style.display = "";
  aiGenUseBtn.style.display = "none";
  aiGenModal.showModal();
});

document.getElementById("aiGenCancel").addEventListener("click", () => aiGenModal.close());

aiGenGenerateBtn.addEventListener("click", async () => {
  const concept = aiGenConcept.value.trim();
  if (!concept) return;
  aiGenLoading.style.display = "";
  aiGenResult.style.display = "none";
  aiGenGenerateBtn.disabled = true;
  try {
    const res = await fetch("/api/generate-character", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": currentUser?.id || "" },
      body: JSON.stringify({ concept })
    });
    if (!res.ok) throw new Error("Generation failed");
    const char = await res.json();
    document.getElementById("aiGenName").value = char.name || "";
    document.getElementById("aiGenTagline").value = char.tagline || "";
    document.getElementById("aiGenPersona").value = char.persona || "";
    document.getElementById("aiGenFirstMsg").value = char.first_message || "";
    document.getElementById("aiGenTags").value = (char.tags || []).join(", ");
    aiGenResult.style.display = "";
    aiGenGenerateBtn.style.display = "none";
    aiGenUseBtn.style.display = "";
  } catch(e) {
    aiGenLoading.innerHTML = `<p style="color:#c0392b;">Failed to generate. ${e.message}</p>`;
  } finally {
    aiGenLoading.style.display = "none";
    aiGenGenerateBtn.disabled = false;
  }
});

aiGenUseBtn.addEventListener("click", () => {
  const name = document.getElementById("aiGenName").value;
  const tagline = document.getElementById("aiGenTagline").value;
  const persona = document.getElementById("aiGenPersona").value;
  const firstMsg = document.getElementById("aiGenFirstMsg").value;
  const tagsStr = document.getElementById("aiGenTags").value;
  aiGenModal.close();
  openCreateModal();
  document.getElementById("charName").value = name;
  document.getElementById("charTagline").value = tagline;
  document.getElementById("charPersona").value = persona;
  document.getElementById("charFirstMsg").value = firstMsg;
  const tags = tagsStr.split(",").map(t => t.trim()).filter(Boolean);
  document.querySelectorAll(".tag-chip").forEach(chip => {
    const isSelected = tags.includes(chip.dataset.tag);
    chip.classList.toggle("selected", isSelected);
  });
  selectedTags = tags;
});

photoInput.addEventListener("change", () => {
  // handled by photo editor
});

// ── Photo editor ──────────────────────────────────────────
const photoEditorOverlay = document.getElementById("photoEditorOverlay");
const photoEditorImg = document.getElementById("photoEditorImg");
const photoEditorCard = document.getElementById("photoEditorCard");
const photoEditorZoom = document.getElementById("photoEditorZoom");
const photoEditorFileInput = document.getElementById("photoEditorFileInput");
const photoThumb = document.getElementById("photoThumb");
const photoBtnLabel = document.getElementById("photoBtnLabel");

let editorPhotoPos = 50;
let editorPhotoZoom = 1.0;
let editorImgNatW = 0, editorImgNatH = 0;

document.getElementById("openPhotoEditor").addEventListener("click", () => {
  photoEditorFileInput.click();
});

document.getElementById("photoEditorPickBtn").addEventListener("click", () => {
  photoEditorFileInput.click();
});

photoEditorFileInput.addEventListener("change", () => {
  const file = photoEditorFileInput.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const max = 768;
    let w = img.width, h = img.height;
    if (w > max || h > max) {
      if (w > h) { h = Math.round(h * max / w); w = max; }
      else { w = Math.round(w * max / h); h = max; }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    pendingPhoto = canvas.toDataURL("image/jpeg", 0.92);
    editorPhotoPos = 50;
    editorPhotoZoom = 1.0;
    photoEditorZoom.value = 1;
    openPhotoEditorUI();
  };
  img.src = URL.createObjectURL(file);
});

photoEditorImg.onload = () => {
  editorImgNatW = photoEditorImg.naturalWidth;
  editorImgNatH = photoEditorImg.naturalHeight;
  applyEditorStyle();
};

function openPhotoEditorUI() {
  if (!pendingPhoto) return;
  editorImgNatW = 0;
  editorImgNatH = 0;
  photoEditorImg.src = pendingPhoto;
  editorPhotoPos = pendingPhotoPos;
  editorPhotoZoom = pendingPhotoZoom;
  photoEditorZoom.value = editorPhotoZoom;
  modal.close();
  photoEditorOverlay.style.display = "";
  if (photoEditorImg.complete && photoEditorImg.naturalWidth) {
    editorImgNatW = photoEditorImg.naturalWidth;
    editorImgNatH = photoEditorImg.naturalHeight;
    applyEditorStyle();
  }
}

function applyEditorStyle() {
  const contW = photoEditorCard.offsetWidth;
  const contH = photoEditorCard.offsetHeight;
  if (!editorImgNatW || !editorImgNatH || !contW || !contH) return;

  const coverScale = Math.max(contW / editorImgNatW, contH / editorImgNatH);
  const scale = coverScale * editorPhotoZoom;
  const w = editorImgNatW * scale;
  const h = editorImgNatH * scale;

  photoEditorImg.style.width = w + "px";
  photoEditorImg.style.height = h + "px";
  photoEditorImg.style.left = ((contW - w) / 2) + "px";
  photoEditorImg.style.top = ((contH - h) * editorPhotoPos / 100) + "px";
}

// Photo editor drag — set up once on load
(function() {
  let dragging = false, startY = 0, startPos = 0;
  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = photoEditorCard.getBoundingClientRect();
    const dy = clientY - startY;
    const pct = (dy / rect.height) * 100;
    editorPhotoPos = Math.max(0, Math.min(100, startPos + pct));
    applyEditorStyle();
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);
  };
  photoEditorCard.onmousedown = (e) => {
    dragging = true;
    startY = e.clientY;
    startPos = editorPhotoPos;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  photoEditorCard.ontouchstart = (e) => {
    dragging = true;
    startY = e.touches[0].clientY;
    startPos = editorPhotoPos;
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  };
})();

photoEditorZoom.addEventListener("input", (e) => {
  editorPhotoZoom = parseFloat(e.target.value);
  applyEditorStyle();
});

document.getElementById("closePhotoEditor").addEventListener("click", () => {
  photoEditorOverlay.style.display = "none";
  if (editingId || document.getElementById("charName").value.trim()) modal.showModal();
});

document.getElementById("photoEditorCancel").addEventListener("click", () => {
  photoEditorOverlay.style.display = "none";
  if (editingId || document.getElementById("charName").value.trim()) modal.showModal();
});

document.getElementById("photoEditorSave").addEventListener("click", () => {
  pendingPhotoPos = editorPhotoPos;
  pendingPhotoZoom = editorPhotoZoom;
  photoEditorOverlay.style.display = "none";
  updatePhotoButton();
  modal.showModal();
});

function updatePhotoButton() {
  if (pendingPhoto) {
    photoThumb.src = pendingPhoto;
    photoThumb.style.objectPosition = `50% ${pendingPhotoPos}%`;
    if (pendingPhotoZoom < 1) {
      photoThumb.style.objectFit = "contain";
      photoThumb.style.transform = "";
    } else {
      photoThumb.style.objectFit = "cover";
      photoThumb.style.transform = pendingPhotoZoom !== 1 ? `scale(${pendingPhotoZoom})` : "";
    }
    photoThumb.classList.add("has-photo");
    photoBtnLabel.textContent = "Change photo";
  } else {
    photoThumb.classList.remove("has-photo");
    photoBtnLabel.textContent = "Add photo";
  }
}

characterForm.addEventListener("submit", async () => {
  const name = nameInput.value.trim();
  const tagline = taglineInput.value.trim();
  const persona = personaInput.value.trim();
  const color = colorInput.value;
  if (!name || !persona) return;
  const data = { name, tagline, persona, color, photo: pendingPhoto, photoPos: pendingPhotoPos, photoZoom: pendingPhotoZoom, firstMessage: firstMsgInput.value.trim(), tags: [...selectedTags] };
  try {
    if (editingId) {
      await updateCharacter(editingId, data);
    } else {
      await createCharacter(data);
    }
    editingId = null;
    pendingPhoto = null;
    await refreshCharacters();
    updateCreateBtnBadge();
  } catch(e) {
    console.error("Save character failed:", e);
    const msg = e.message || "";
    if (msg.includes("200 coins") || msg.includes("No free uses")) {
      buyCoinsModal.querySelector(".buy-coins-title").textContent = "Not Enough Coins";
      buyCoinsModal.showModal();
    } else if (e.message === "Permission denied") {
      showAlert("Error", "You don't have permission to edit the character.");
    } else {
      showAlert("Error", "Failed to save character.");
    }
  }
  modal.close();
});

// Settings modal
const settingsModal = document.getElementById("settingsModal");
const settingsThemeToggle = document.getElementById("settingsThemeToggle");
const closeSettings = document.getElementById("closeSettings");

function updateToggleVisual() {
  const isLight = settings.theme === "light";
  settingsThemeToggle.querySelector(".dark-label").style.color = isLight ? "var(--text-dim)" : "var(--accent-bright)";
  settingsThemeToggle.querySelector(".light-label").style.color = isLight ? "var(--accent-bright)" : "var(--text-dim)";
}

document.getElementById("settingsBtn").addEventListener("click", () => {
  updateToggleVisual();
  updateLongerMsgUI();
  settingsModal.showModal();
});

settingsThemeToggle.addEventListener("click", () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  applyTheme(settings.theme);
  saveSettings(settings);
  updateToggleVisual();
});

closeSettings.addEventListener("click", () => {
  settingsModal.close();
});

settingsModal.addEventListener("close", () => {
  saveSettings(settings);
});

const themesModal = document.getElementById("themesModal");
document.getElementById("openThemesBtn").addEventListener("click", () => {
  settingsModal.close();
  fetchAndRenderThemes();
  themesModal.showModal();
});
document.getElementById("closeThemesBtn").addEventListener("click", () => {
  themesModal.close();
});
themesModal.addEventListener("click", (e) => {
  if (e.target === themesModal) themesModal.close();
});

document.querySelectorAll(".color-swatch").forEach(swatch => {
  swatch.addEventListener("click", () => {
    settings.msgColor = swatch.dataset.color;
    applyMsgColor(settings.msgColor);
    saveSettings(settings);
    fetch("/api/themes/msg-color", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ color: settings.msgColor }) });
  });
});

// ── Membership ────────────────────────────────────────────
const membershipModal = document.getElementById("membershipModal");
const membershipSubscribed = document.getElementById("membershipSubscribed");
const subscribeBtn = document.getElementById("subscribeBtn");

document.getElementById("membershipBtn").addEventListener("click", () => {
  if (isSubscriber) {
    membershipSubscribed.style.display = "";
    subscribeBtn.style.display = "none";
  } else {
    membershipSubscribed.style.display = "none";
    subscribeBtn.style.display = "";
  }
  membershipModal.showModal();
});

document.getElementById("closeMembership").addEventListener("click", () => membershipModal.close());
membershipModal.addEventListener("click", (e) => { if (e.target === membershipModal) membershipModal.close(); });

subscribeBtn.addEventListener("click", async () => {
  if (!currentUser) { membershipModal.close(); return requireAuth(); }
  try {
    const res = await fetch("/api/subscription/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": currentUser.id }
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert(data.error || "Failed to start checkout.");
    }
  } catch(e) {
    alert("Failed to start checkout.");
  }
});

// Longer messages toggle
const longerMsgRow = document.getElementById("longerMsgRow");
const longerMsgToggle = document.getElementById("longerMsgToggle");

function updateLongerMsgUI() {
  longerMsgRow.style.display = isSubscriber ? "" : "none";
  const thumb = longerMsgToggle.querySelector(".toggle-thumb");
  const offLabel = longerMsgToggle.querySelector(".toggle-label-off");
  const onLabel = longerMsgToggle.querySelector(".toggle-label-on");
  if (longerMessages) {
    thumb.style.transform = "translateX(20px)";
    offLabel.style.color = "var(--text-dim)";
    onLabel.style.color = "var(--accent-bright)";
  } else {
    thumb.style.transform = "";
    offLabel.style.color = "var(--accent-bright)";
    onLabel.style.color = "var(--text-dim)";
  }
}

longerMsgToggle.addEventListener("click", async () => {
  if (!currentUser) return;
  try {
    const res = await fetch("/api/subscription/toggle-longer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": currentUser.id }
    });
    const data = await res.json();
    longerMessages = data.longer_messages;
    updateLongerMsgUI();
  } catch(e) {}
});

function openSettingsWithSubscription() {
  updateLongerMsgUI();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function editIconSvg() {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
  </svg>`;
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + "m";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return n;
}

function buildCard(c, { showSnippet, showEdit } = {}) {
  const card = document.createElement("button");
  card.className = "card";
  const tagsHtml = (c.tags && c.tags.length) ? c.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join("") : "";
  const snippetHtml = showSnippet && c._lastMessage
    ? `<p class="card-snippet">${escapeHtml(c._lastMessage)}</p>`
    : `<p class="card-desc">${escapeHtml(c.persona)}</p>`;
  const count = c.message_count || 0;
  const likeCount = c.like_count || 0;
  const isLiked = c.liked ? " liked" : "";
  const isFav = c.favorited ? " favorited" : "";
  const canEdit = isAdmin || (showEdit && currentUser && c.created_by === currentUser.id);
  card.innerHTML = `
    <button class="card-fav${isFav}" title="Toggle favorite" aria-label="Toggle favorite for ${escapeHtml(c.name)}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="${c.favorited ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
    </button>
    ${canEdit ? `<button class="card-edit" title="Edit ${escapeHtml(c.name)}" aria-label="Edit ${escapeHtml(c.name)}">${editIconSvg()}</button>` : ""}
    <button class="card-details" title="View details" aria-label="View details for ${escapeHtml(c.name)}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
    </button>
    <div class="card-photo-wrap">
      <img class="card-photo" src="${avatarSrc(c)}" style="${avatarStyle(c)}" alt="${escapeHtml(c.name)}">
      <button class="card-like${isLiked}" title="Like" aria-label="Like ${escapeHtml(c.name)}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="${c.liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        ${likeCount > 0 ? `<span class="card-like-count">${formatCount(likeCount)}</span>` : ""}
      </button>
    </div>
    <div class="card-body">
      <p class="card-name">${escapeHtml(c.name)}${count > 0 ? ` <span class="card-chat-count" title="${count} messages"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${formatCount(count)}</span>` : ""}</p>
      ${c.creator_name ? `<span class="card-creator">@${escapeHtml(c.creator_name)}</span>` : ""}
      ${c.tagline ? `<p class="card-tagline">${escapeHtml(c.tagline)}</p>` : ""}
      ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}
      ${snippetHtml}
    </div>
  `;
  card.addEventListener("click", () => openChat(c.id));
  const editBtn = card.querySelector(".card-edit");
  if (editBtn) {
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(c);
    });
  }
  card.querySelector(".card-details").addEventListener("click", (e) => {
    e.stopPropagation();
    openCharInfo(c);
  });
  const creatorBtn = card.querySelector(".card-creator");
  if (creatorBtn) {
    creatorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openProfile(c.created_by);
    });
  }
  card.querySelector(".card-fav").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!requireAuth()) return;
    const btn = e.currentTarget;
    try {
      if (c.favorited) {
        await unfavoriteCharacter(c.id);
        c.favorited = false;
      } else {
        await favoriteCharacter(c.id);
        c.favorited = true;
      }
      btn.classList.toggle("favorited", c.favorited);
      btn.querySelector("svg").setAttribute("fill", c.favorited ? "currentColor" : "none");
    } catch(err) {
      console.error("Favorite failed:", err);
    }
  });
  card.querySelector(".card-like").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!requireAuth()) return;
    const btn = e.currentTarget;
    try {
      if (c.liked) {
        const result = await unlikeCharacter(c.id);
        c.liked = false;
        c.like_count = result.like_count;
      } else {
        const result = await likeCharacter(c.id);
        c.liked = true;
        c.like_count = result.like_count;
      }
      btn.classList.toggle("liked", c.liked);
      btn.querySelector("svg").setAttribute("fill", c.liked ? "currentColor" : "none");
      const countEl = btn.querySelector(".card-like-count");
      if (c.like_count > 0) {
        if (countEl) {
          countEl.textContent = formatCount(c.like_count);
        } else {
          const span = document.createElement("span");
          span.className = "card-like-count";
          span.textContent = formatCount(c.like_count);
          btn.appendChild(span);
        }
      } else if (countEl) {
        countEl.remove();
      }
    } catch(err) {
      console.error("Like failed:", err);
    }
  });
  return card;
}

async function refreshCharacters() {
  characters = await loadCharacters();
  renderGallery();
  applyAdminUI();
}

function renderGallery() {
  filterSearchText = "";
  filterActiveTags = [];
  renderFilterTags();
  searchInput.value = "";
  currentPage = 1;
  runFilteredGallery();
}

function renderFilterPagination(totalPages) {
  const container = document.getElementById("pagination");
  if (!container) return;
  container.innerHTML = "";
  if (totalPages <= 1) return;
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement("button");
    btn.className = "page-btn" + (i === currentPage ? " page-btn-active" : "");
    btn.textContent = i;
    const pageNum = i;
    btn.addEventListener("click", () => {
      currentPage = pageNum;
      runFilteredGallery();
      renderFilterPagination(Math.ceil(getFilteredCharacters().length / 12));
    });
    container.appendChild(btn);
  }
}

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    filterSearchText = searchInput.value;
    applyFilters();
  }
});

searchBtn.addEventListener("click", () => {
  filterSearchText = searchInput.value;
  applyFilters();
});

async function renderRecentGallery() {
  if (!currentUser) {
    recentChatsGalleryEl.innerHTML = `<p class="card-desc">Sign in to see your chats.</p>`;
    return;
  }
  const allMsgs = await Promise.all(characters.map(c => loadMessages(c.id)));
  const recent = [];
  characters.forEach((c, i) => {
    const msgs = allMsgs[i];
    if (msgs.length > 0) {
      recent.push({ ...c, _lastMessage: msgs[msgs.length - 1].content, _msgCount: msgs.length });
    }
  });
  recent.sort((a, b) => (b._lastMessage ? 1 : 0) - (a._lastMessage ? 1 : 0));
  recentChatsGalleryEl.innerHTML = "";
  if (recent.length === 0) {
    recentChatsGalleryEl.innerHTML = `<p class="card-desc">Nothing yet — open a character and say hi.</p>`;
    return;
  }
  recent.forEach(c => recentChatsGalleryEl.appendChild(buildCard(c, { showSnippet: true })));
}

function renderFavoritesGallery() {
  const favChars = characters.filter(c => c.favorited);
  favoritesGalleryEl.innerHTML = "";
  if (favChars.length === 0) {
    favoritesGalleryEl.innerHTML = `<p class="card-desc">No favorites yet — click the star on any character to save it here.</p>`;
    return;
  }
  favChars.forEach(c => favoritesGalleryEl.appendChild(buildCard(c)));
}

function renderTrendingGallery() {
  const sorted = [...characters].sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
  trendingGalleryEl.innerHTML = "";
  if (sorted.length === 0) {
    trendingGalleryEl.innerHTML = `<p class="card-desc">No characters yet.</p>`;
    return;
  }
  sorted.forEach(c => trendingGalleryEl.appendChild(buildCard(c)));
}

function renderMostLikedGallery() {
  const sorted = [...characters].sort((a, b) => (b.like_count || 0) - (a.like_count || 0));
  mostLikedGalleryEl.innerHTML = "";
  if (sorted.length === 0) {
    mostLikedGalleryEl.innerHTML = `<p class="card-desc">No characters yet.</p>`;
    return;
  }
  sorted.forEach(c => mostLikedGalleryEl.appendChild(buildCard(c)));
}

function setTab(tab) {
  homeNavBtn.classList.toggle("active", tab === "home");
  recentChatsBtn.classList.toggle("active", tab === "chats");
  favoritesBtn.classList.toggle("active", tab === "favorites");
  myCharactersBtn.classList.toggle("active", tab === "myCharacters");
  trendingBtn.classList.toggle("active", tab === "trending");
  mostLikedBtn.classList.toggle("active", tab === "mostLiked");
  questsBtn.classList.toggle("active", tab === "quests");
  groupChatsBtn.classList.toggle("active", tab === "groupChats");
  if (tab) localStorage.setItem("sceneai_activeTab", tab);
}

let savedGalleryScroll = 0;
let previousViewFn = null;
let profileReturnUserId = null;

function showGallery() {
  activeId = null;
  localStorage.removeItem("sceneai_activeChat");
  chatView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  galleryView.hidden = false;
  setTab("home");
  renderGallery();
  document.querySelector(".app").classList.remove("chat-active");
  document.querySelector(".main-content").scrollTop = savedGalleryScroll;
}

function showRecentChats() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  recentChatsView.hidden = false;
  setTab("chats");
  document.querySelector(".app").classList.remove("chat-active");
  renderRecentGallery();
}

function showFavorites() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  favoritesView.hidden = false;
  setTab("favorites");
  document.querySelector(".app").classList.remove("chat-active");
  renderFavoritesGallery();
}

function showTrending() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  trendingView.hidden = false;
  setTab("trending");
  document.querySelector(".app").classList.remove("chat-active");
  renderTrendingGallery();
}

function showMostLiked() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  mostLikedView.hidden = false;
  setTab("mostLiked");
  document.querySelector(".app").classList.remove("chat-active");
  renderMostLikedGallery();
}

function showMyCharacters() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  myCharactersView.hidden = false;
  setTab("myCharacters");
  document.querySelector(".app").classList.remove("chat-active");
  renderMyCharactersGallery();
}

function renderMyCharactersGallery() {
  if (!currentUser) {
    myCharactersGalleryEl.innerHTML = `<p class="card-desc">Sign in to see your characters.</p>`;
    return;
  }
  const mine = characters.filter(c => c.created_by === currentUser.id);
  myCharactersGalleryEl.innerHTML = "";
  if (mine.length === 0) {
    myCharactersGalleryEl.innerHTML = `<p class="card-desc">You haven't created any characters yet.</p>`;
    return;
  }
  mine.forEach(c => myCharactersGalleryEl.appendChild(buildCard(c, { showEdit: true })));
}

function showQuests() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  questsView.hidden = false;
  setTab("quests");
  document.querySelector(".app").classList.remove("chat-active");
  renderQuests();
}

async function renderQuests() {
  if (!currentUser) {
    questsContentEl.innerHTML = `<p class="card-desc">Sign in to see your quests.</p>`;
    return;
  }
  questsContentEl.innerHTML = `<p class="quest-loading">Loading quests...</p>`;
  try {
    const res = await fetch(`/api/quests?userId=${currentUser.id}&tz=${-new Date().getTimezoneOffset()}`);
    const quests = await res.json();
    if (!quests.length) {
      questsContentEl.innerHTML = `<p class="card-desc">No quests available yet.</p>`;
      return;
    }
    const daily = quests.filter(q => q.category === "daily");
    const weekly = quests.filter(q => q.category === "weekly");
    const oneTime = quests.filter(q => q.category === "one_time");
    let html = "";
    if (daily.length) {
      html += `<div class="quest-category"><h3 class="quest-category-title">Daily Quests</h3><div class="quest-list">${daily.map(questCardHtml).join("")}</div></div>`;
    }
    if (weekly.length) {
      html += `<div class="quest-category"><h3 class="quest-category-title">Weekly Quests</h3><div class="quest-list">${weekly.map(questCardHtml).join("")}</div></div>`;
    }
    if (oneTime.length) {
      html += `<div class="quest-category"><h3 class="quest-category-title">One-Time Quests</h3><div class="quest-list">${oneTime.map(questCardHtml).join("")}</div></div>`;
    }
    questsContentEl.innerHTML = html;
    questsContentEl.querySelectorAll(".quest-claim-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "...";
        try {
          const res = await fetch(`/api/quests/${btn.dataset.questId}/claim`, { method: "POST", headers: { "x-user-id": currentUser.id } });
          const data = await res.json();
          if (data.ok) {
            btn.textContent = "Claimed!";
            btn.classList.add("claimed");
            renderQuests();
          } else {
            btn.textContent = "Error";
            btn.disabled = false;
          }
        } catch(e) {
          btn.textContent = "Error";
          btn.disabled = false;
        }
      });
    });
  } catch(e) {
    questsContentEl.innerHTML = `<p class="card-desc">Failed to load quests.</p>`;
  }
}

function questCardHtml(q) {
  const pct = q.target > 0 ? Math.min(100, Math.round((q.progress / q.target) * 100)) : 0;
  const claimClass = q.claimed ? " claimed" : (q.complete ? " ready" : "");
  const claimText = q.claimed ? "Claimed" : (q.complete ? `Claim +${q.reward}` : `${q.progress}/${q.target}`);
  const claimDisabled = q.claimed || !q.complete ? "disabled" : "";
  return `<div class="quest-card${q.complete && !q.claimed ? " quest-complete" : ""}">
    <div class="quest-info">
      <p class="quest-name">${escapeHtml(q.name)} <span class="quest-reward">+${q.reward} coins</span></p>
      <p class="quest-desc">${escapeHtml(q.desc)}</p>
    </div>
    <div class="quest-right">
      <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${pct}%"></div></div>
      <button class="quest-claim-btn${claimClass}" data-quest-id="${q.id}" ${claimDisabled}>${claimText}</button>
    </div>
  </div>`;
}

homeNavBtn.addEventListener("click", showGallery);
recentChatsBtn.addEventListener("click", showRecentChats);
favoritesBtn.addEventListener("click", showFavorites);
myCharactersBtn.addEventListener("click", showMyCharacters);
questsBtn.addEventListener("click", showQuests);
trendingBtn.addEventListener("click", showTrending);
mostLikedBtn.addEventListener("click", showMostLiked);

let currentMessages = [];

async function openChat(id) {
  activeId = id;
  localStorage.setItem("sceneai_activeChat", id);
  const c = characters.find(x => x.id === id);
  activeNameEl.textContent = c.name;
  activeTaglineEl.innerHTML = "";
  if (c.creator_name) {
    const link = document.createElement("span");
    link.className = "card-creator";
    link.textContent = `@${c.creator_name}`;
    link.style.cursor = "pointer";
    link.addEventListener("click", () => openProfile(c.created_by));
    activeTaglineEl.appendChild(link);
  }
  activeAvatarEl.src = avatarSrc(c);
  activeAvatarEl.style.objectPosition = `50% ${c.photo_pos != null ? c.photo_pos : 50}%`;
  const avatarZoom = c.photo_zoom != null ? c.photo_zoom : 1;
  if (avatarZoom < 1) {
    activeAvatarEl.style.objectFit = "contain";
    activeAvatarEl.style.transform = "";
  } else {
    activeAvatarEl.style.objectFit = "cover";
    activeAvatarEl.style.transform = avatarZoom !== 1 ? `scale(${avatarZoom})` : "";
  }
  savedGalleryScroll = document.querySelector(".main-content").scrollTop;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  publicProfileView.hidden = true;
  chatView.hidden = false;
  document.querySelector(".app").classList.add("chat-active");
  if (activeChatTheme === "galaxy") injectGalaxyStars();
  currentMessages = await loadMessages(id);
  renderMessages();
  input.value = "";
  input.focus();
  document.querySelector(".main-content").style.background = "";
}

backBtn.addEventListener("click", () => { if (profileReturnUserId) { const uid = profileReturnUserId; profileReturnUserId = null; openProfile(uid); } else { showGallery(); } });

// ── Chat header menu ──────────────────────────────────────
const chatMenuBtn = document.getElementById("chatMenuBtn");
const chatMenuDropdown = document.getElementById("chatMenuDropdown");
const chatMenuConfigure = document.getElementById("chatMenuConfigure");
const chatMenuDelete = document.getElementById("chatMenuDelete");
const charInfoModal = document.getElementById("charInfoModal");
const charInfoPhoto = document.getElementById("charInfoPhoto");
const charInfoName = document.getElementById("charInfoName");
const charInfoTagline = document.getElementById("charInfoTagline");
const charInfoPersona = document.getElementById("charInfoPersona");

chatMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  chatMenuDropdown.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".chat-header-menu")) {
    chatMenuDropdown.classList.remove("open");
  }
});

function openCharInfo(c) {
  charInfoPhoto.src = avatarSrc(c);
  charInfoPhoto.style.objectPosition = `50% ${c.photo_pos != null ? c.photo_pos : 50}%`;
  const zoom = c.photo_zoom != null ? c.photo_zoom : 1;
  if (zoom < 1) {
    charInfoPhoto.style.objectFit = "contain";
    charInfoPhoto.style.transform = "";
  } else {
    charInfoPhoto.style.objectFit = "cover";
    charInfoPhoto.style.transform = zoom !== 1 ? `scale(${zoom})` : "";
  }
  charInfoName.textContent = c.name;
  charInfoTagline.textContent = c.tagline || "";
  const tagsHtml = (c.tags && c.tags.length) ? c.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join("") : "";
  document.getElementById("charInfoTags").innerHTML = tagsHtml;
  const count = c.message_count || 0;
  document.getElementById("charInfoCount").textContent = count > 0 ? `${formatCount(count)} message${count !== 1 ? "s" : ""} across all chats` : "No messages yet";
  charInfoPersona.textContent = c.persona;
  charInfoModal.showModal();
}

chatMenuConfigure.addEventListener("click", () => {
  chatMenuDropdown.classList.remove("open");
  const c = characters.find(x => x.id === activeId);
  if (!c) return;
  openCharInfo(c);
});

document.getElementById("closeCharInfo").addEventListener("click", () => charInfoModal.close());
charInfoModal.addEventListener("click", (e) => {
  if (e.target === charInfoModal) charInfoModal.close();
});

chatMenuDelete.addEventListener("click", async () => {
  chatMenuDropdown.classList.remove("open");
  const c = characters.find(x => x.id === activeId);
  if (!c) return;
  if (!(await showConfirm(`Delete your conversation with ${c.name}? This cannot be undone.`))) return;
  currentMessages = [];
  await saveMessages(activeId, []);
  renderMessages();
});

const chatMenuMemory = document.getElementById("chatMenuMemory");

chatMenuMemory.addEventListener("click", () => {
  chatMenuDropdown.classList.remove("open");
  openMemoryPanel();
});

// ── Memory Panel ──────────────────────────────────────────
const memoryPanel = document.getElementById("memoryPanel");
const memoryList = document.getElementById("memoryList");
const memoryInput = document.getElementById("memoryInput");
const memoryAddBtn = document.getElementById("memoryAddBtn");
const memoryCloseBtn = document.getElementById("memoryCloseBtn");
let memoryPanelOpen = false;

async function openMemoryPanel() {
  if (!activeId) return;
  memoryPanelOpen = true;
  memoryPanel.classList.add("open");
  await refreshMemoryList();
}

async function closeMemoryPanel() {
  memoryPanelOpen = false;
  memoryPanel.classList.remove("open");
}

async function refreshMemoryList() {
  if (!activeId || !currentUser) return;
  const memories = await loadMemories(activeId);
  memoryList.innerHTML = "";
  if (memories.length === 0) {
    memoryList.innerHTML = `<p class="memory-empty">No memories yet. Add facts about yourself that ${characters.find(x => x.id === activeId)?.name || "the character"} should remember.</p>`;
    return;
  }
  memories.forEach(m => {
    const item = document.createElement("div");
    item.className = "memory-item";
    item.innerHTML = `
      <p class="memory-text">${escapeHtml(m.content)}</p>
      <button class="memory-delete-btn" title="Remove memory">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    item.querySelector(".memory-delete-btn").addEventListener("click", async () => {
      await deleteMemory(activeId, m.id);
      await refreshMemoryList();
    });
    memoryList.appendChild(item);
  });
}

memoryAddBtn.addEventListener("click", async () => {
  const text = memoryInput.value.trim();
  if (!text || !activeId) return;
  await addMemory(activeId, text);
  memoryInput.value = "";
  await refreshMemoryList();
});

memoryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    memoryAddBtn.click();
  }
});

memoryCloseBtn.addEventListener("click", closeMemoryPanel);



let openDropdown = null;

function closeAllDropdowns() {
  if (openDropdown) {
    openDropdown.classList.remove("open");
    openDropdown = null;
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".msg-menu-btn") && !e.target.closest(".msg-dropdown")) {
    closeAllDropdowns();
  }
});

function formatMsg(text) {
  return text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, (match, inner) => {
    const withQuotes = inner.replace(/"([^"<\n]*)"/g, '<span class="plain">$1</span>');
    return '<span class="bold">' + withQuotes + '</span>';
  }).replace(/\*\s*([^\s*][\s\S]+?[^\s*])\s*\*/g, (match, inner) => {
    const withPlain = inner.replace(/"([^"<\n]*)"/g, '<span class="plain">$1</span>');
    return '<span class="emph">' + withPlain + '</span>';
  });
}

function renderMessages() {
  const c = characters.find(x => x.id === activeId);
  messagesEl.innerHTML = "";
  closeAllDropdowns();

  if (c && c.first_message) {
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap character first-msg-wrap";
    const div = document.createElement("div");
    div.className = "msg character first-msg";
    div.innerHTML = formatMsg(c.first_message);
    wrap.appendChild(div);
    messagesEl.appendChild(wrap);
  }

  if (!c || currentMessages.length === 0) {
    if (!c || !c.first_message) {
      messagesEl.innerHTML = `<div class="empty-state"><p>Say hi to ${c ? escapeHtml(c.name) : "your character"}.</p></div>`;
    }
    return;
  }
  currentMessages.forEach((m, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (m.role === "user" ? "user" : "character");

    const div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "character");
    div.innerHTML = formatMsg(m.content);

    const menuBtn = document.createElement("button");
    menuBtn.className = "msg-menu-btn";
    menuBtn.innerHTML = "⋮";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = wrap.querySelector(".msg-dropdown");
      if (openDropdown && openDropdown !== dd) openDropdown.classList.remove("open");
      dd.classList.toggle("open");
      openDropdown = dd.classList.contains("open") ? dd : null;
    });

    const dropdown = document.createElement("div");
    dropdown.className = "msg-dropdown";

    const editBtn = document.createElement("button");
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Edit`;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      startEditMessage(idx, wrap);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      deleteMessage(idx);
    });

    dropdown.appendChild(editBtn);
    dropdown.appendChild(deleteBtn);

    const editArea = document.createElement("div");
    editArea.className = "msg-edit-area";
    editArea.innerHTML = `
      <textarea class="msg-edit-input">${escapeHtml(m.content)}</textarea>
      <div class="msg-edit-actions">
        <button class="cancel-edit" type="button">Cancel</button>
        <button class="save-edit" type="button">Save</button>
      </div>
    `;

    editArea.querySelector(".cancel-edit").addEventListener("click", () => {
      wrap.classList.remove("msg-editing");
    });

    editArea.querySelector(".save-edit").addEventListener("click", async () => {
      const textarea = editArea.querySelector(".msg-edit-input");
      const newContent = textarea.value.trim();
      if (!newContent) return;
      currentMessages[idx].content = newContent;
      await saveMessages(activeId, currentMessages);
      renderMessages();
    });

    editArea.querySelector(".msg-edit-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        editArea.querySelector(".save-edit").click();
      }
      if (e.key === "Escape") {
        wrap.classList.remove("msg-editing");
      }
    });

    wrap.appendChild(div);
    wrap.appendChild(menuBtn);
    wrap.appendChild(dropdown);
    wrap.appendChild(editArea);

    if (m.role !== "user" && idx === currentMessages.length - 1) {
      const regenBtn = document.createElement("button");
      regenBtn.className = "msg-regen-btn";
      regenBtn.title = "Regenerate response";
      regenBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>`;
      regenBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        regenerateResponse(idx);
      });
      wrap.appendChild(regenBtn);
    }

    messagesEl.appendChild(wrap);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function startEditMessage(idx, wrap) {
  wrap.classList.add("msg-editing");
  const textarea = wrap.querySelector(".msg-edit-input");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function deleteMessage(idx) {
  const m = currentMessages[idx];
  const preview = m.content.length > 40 ? m.content.slice(0, 40) + "..." : m.content;
  if (await showConfirm(`Delete this message?\n\n"${preview}"`)) {
    currentMessages.splice(idx, 1);
    await saveMessages(activeId, currentMessages);
    renderMessages();
  }
}

async function regenerateResponse(idx) {
  const c = characters.find(x => x.id === activeId);
  currentMessages.splice(idx, 1);
  await saveMessages(activeId, currentMessages);
  renderMessages();
  const typingEl = document.createElement("div");
  typingEl.className = "msg typing";
  typingEl.textContent = `${c.name} is typing…`;
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  sendBtn.disabled = true;
  input.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: c.persona, firstMessage: c.first_message || "", history: currentMessages, username: profileData.username || (currentUser ? currentUser.name.split(" ")[0] : "User"), characterId: activeId, userId: currentUser ? currentUser.id : null })
    });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const data = await res.json();
    const newMsg = { role: "assistant", content: data.reply, ts: Date.now() };
    currentMessages.push(newMsg);
    await addMessage(activeId, "assistant", newMsg.content, newMsg.ts);
  } catch (err) {
    const errMsg = "(Something went wrong reaching the server. Check that your backend is running and your API key is set.)";
    currentMessages.push({ role: "assistant", content: errMsg, ts: Date.now() });
    await addMessage(activeId, "assistant", errMsg, Date.now());
    console.error(err);
  } finally {
    typingEl.remove();
    sendBtn.disabled = false;
    input.disabled = false;
    renderMessages();
    input.focus();
  }
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.dispatchEvent(new Event("submit"));
  }
});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireAuth()) return;
  const text = input.value.trim();
  if (!text || !activeId) return;
  const c = characters.find(x => x.id === activeId);
  const userMsg = { role: "user", content: text, ts: Date.now() };
  currentMessages.push(userMsg);
  await addMessage(activeId, "user", userMsg.content, userMsg.ts);
  renderMessages();
  input.value = "";
  input.style.height = "auto";
  const typingEl = document.createElement("div");
  typingEl.className = "msg typing";
  typingEl.textContent = `${c.name} is typing…`;
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  sendBtn.disabled = true;
  input.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: c.persona, firstMessage: c.first_message || "", history: currentMessages, username: profileData.username || (currentUser ? currentUser.name.split(" ")[0] : "User"), characterId: activeId, userId: currentUser ? currentUser.id : null })
    });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const data = await res.json();
    const assistantMsg = { role: "assistant", content: data.reply, ts: Date.now() };
    currentMessages.push(assistantMsg);
    await addMessage(activeId, "assistant", assistantMsg.content, assistantMsg.ts);
  } catch (err) {
    const errMsg = "(Something went wrong reaching the server. Check that your backend is running and your API key is set.)";
    currentMessages.push({ role: "assistant", content: errMsg, ts: Date.now() });
    await addMessage(activeId, "assistant", errMsg, Date.now());
    console.error(err);
  } finally {
    typingEl.remove();
    sendBtn.disabled = false;
    input.disabled = false;
    renderMessages();
    input.focus();
  }
});

// ===== Google Sign-In =====
const GOOGLE_CLIENT_ID = "793983971848-7h07n17ln6h5atefihe2pm04849vo9v1.apps.googleusercontent.com";

const googleSignInWrapper = document.getElementById("googleSignInWrapper");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const userMenu = document.getElementById("userMenu");
const userMenuBtn = document.getElementById("userMenuBtn");
const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");
const profileModal = document.getElementById("profileModal");
const profileForm = document.getElementById("profileForm");
const profilePicPreview = document.getElementById("profilePicPreview");
const profilePicInput = document.getElementById("profilePicInput");
const removeProfilePic = document.getElementById("removeProfilePic");
const profileUsername = document.getElementById("profileUsername");
const cancelProfile = document.getElementById("cancelProfile");
const switchAccountBtn = document.getElementById("switchAccountBtn");
const logoutBtn = document.getElementById("logoutBtn");
const deleteAccountBtn = document.getElementById("deleteAccountBtn");

let profileData = {};

function parseJwt(token) {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const jsonPayload = decodeURIComponent(
    atob(base64).split("").map(c =>
      "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)
    ).join("")
  );
  return JSON.parse(jsonPayload);
}

function handleOAuthRedirect() {
  const hash = window.location.hash;
  if (!hash || !hash.includes("access_token")) return;
  const params = new URLSearchParams(hash.substring(1));
  const accessToken = params.get("access_token");
  if (!accessToken) return;
  history.replaceState(null, "", window.location.pathname);
  fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  .then(r => r.json())
  .then(data => {
    if (data.id) {
      currentUser = { id: data.id, name: data.name, email: data.email, picture: data.picture };
      localStorage.setItem("sceneai_user", JSON.stringify(currentUser));
      loadProfileData().then(() => {
        settings = loadSettings();
        applyTheme(settings.theme);
        applyMsgColor(settings.msgColor || "#c9952c");
        if (!profileData.username) {
          profileData.username = generateRandomUsername();
          saveProfileData();
        }
          checkAdmin().then(() => checkSubscription().then(() => {
          applyAdminUI();
          refreshCharacters();
          showUserMenu();
          checkDailyReward();
          fetchAndRenderThemes();
        }));
      });
    }
  })
  .catch(e => console.error("OAuth redirect handling failed:", e));
}

function generateRandomUsername() {
  const adjectives = ["Shadow", "Crimson", "Velvet", "Lunar", "Silent", "Golden", "Iron", "Mystic", "Blazing", "Frozen", "Wild", "Brave", "Dark", "Swift", "Savage"];
  const nouns = ["Fox", "Wolf", "Raven", "Phoenix", "Tiger", "Panther", "Dragon", "Storm", "Viper", "Hawk", "Lynx", "Cobra", "Bear", "Eagle", "Shark"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${adj}${noun}${num}`;
}

function getProfileKey() {
  if (currentUser && currentUser.id) return `sceneai_profile_${currentUser.id}`;
  return "sceneai_profile";
}

async function loadProfileData() {
  profileData = JSON.parse(localStorage.getItem(getProfileKey()) || "{}");
  if (!currentUser || !currentUser.id) return;
  try {
    const res = await fetch(`/api/profile/${currentUser.id}`);
    const serverProfile = await res.json();
    if (serverProfile && (serverProfile.username || serverProfile.picture)) {
      profileData.username = serverProfile.username || profileData.username;
      profileData.picture = serverProfile.picture || profileData.picture;
      localStorage.setItem(getProfileKey(), JSON.stringify(profileData));
    } else if (profileData.username || profileData.picture) {
      fetch(`/api/profile/${currentUser.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: profileData.username, picture: profileData.picture })
      }).catch(() => {});
    }
  } catch(e) {
    console.warn("Could not load server profile:", e);
  }
}

function saveProfileData() {
  try {
    localStorage.setItem(getProfileKey(), JSON.stringify(profileData));
  } catch(e) {
    console.warn("Could not save profile:", e);
  }
  if (currentUser && currentUser.id) {
    fetch(`/api/profile/${currentUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: profileData.username, picture: profileData.picture })
    }).catch(e => console.warn("Could not sync profile to server:", e));
  }
}

function updateProfileDisplay() {
  if (!currentUser) return;
  const nameEl = document.getElementById("userName");
  if (nameEl) {
    nameEl.textContent = profileData.username || currentUser.name.split(" ")[0];
  }
  const avatarEl = document.getElementById("userAvatar");
  if (avatarEl) {
    if (profileData.picture) {
      avatarEl.src = profileData.picture;
    } else {
      avatarEl.src = fallbackAvatar(profileData.username || currentUser.name.split(" ")[0], "#c9952c");
    }
  }
}

function showUserMenu() {
  googleSignInWrapper.style.cssText = "height:0;width:0;overflow:hidden;opacity:0;pointer-events:none;";
  userMenu.hidden = false;
  updateProfileDisplay();
}

function showSignIn() {
  userMenu.hidden = true;
  currentUser = null;
  profileData = {};
  googleSignInBtn.innerHTML = "";
  googleSignInWrapper.style.cssText = "";
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
    ui_locale: "en"
  });
  google.accounts.id.renderButton(
    googleSignInBtn,
    { type: "standard", size: "small", theme: "outline", text: "signin", shape: "pill", width: 120 }
  );
}

async function handleCredentialResponse(response) {
  const payload = parseJwt(response.credential);
  currentUser = {
    id: payload.sub,
    name: payload.name,
    email: payload.email,
    picture: payload.picture
  };
  localStorage.setItem("sceneai_user", JSON.stringify(currentUser));

  await loadProfileData();
  settings = loadSettings();
  applyTheme(settings.theme);
  applyMsgColor(settings.msgColor || "#c9952c");
  if (!profileData.username) {
    profileData.username = generateRandomUsername();
    saveProfileData();
  }
  await checkAdmin();
  await checkSubscription();
  applyAdminUI();
  await refreshCharacters();
  showUserMenu();
  location.reload();
}

function initGoogleSignIn() {
  if (typeof google === "undefined" || !google.accounts) {
    setTimeout(initGoogleSignIn, 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
    ui_locale: "en"
  });
  google.accounts.id.renderButton(
    googleSignInBtn,
    { type: "standard", size: "small", theme: "outline", text: "signin", shape: "pill", width: 120 }
  );
}

function openGoogleAccountPicker() {
  return new Promise((resolve) => {
    if (typeof google === "undefined" || !google.accounts) {
      setTimeout(() => openGoogleAccountPicker().then(resolve), 200);
      return;
    }
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response) => {
        handleCredentialResponse(response);
        resolve(true);
      },
      auto_select: false,
      ui_locale: "en"
    });
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment() || notification.isDismissedMoment()) {
        resolve(false);
      }
    });
  });
}

function loadProfile() {
  if (profileData.picture) {
    profilePicPreview.src = profileData.picture;
  } else {
    profilePicPreview.src = fallbackAvatar(profileData.username || "User", "#c9952c");
  }
  profileUsername.value = profileData.username || "";
}

userMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  loadProfile();
  profileModal.showModal();
});

document.getElementById("viewMyProfileBtn").addEventListener("click", () => {
  profileModal.close();
  openProfile(currentUser.id);
});

profilePicInput.addEventListener("change", () => {
  const file = profilePicInput.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const max = 512;
    let w = img.width, h = img.height;
    if (w > max || h > max) {
      if (w > h) { h = Math.round(h * max / w); w = max; }
      else { w = Math.round(w * max / h); h = max; }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    profileData.picture = canvas.toDataURL("image/jpeg", 0.85);
    profilePicPreview.src = profileData.picture;
    saveProfileData();
    updateProfileDisplay();
  };
  img.src = URL.createObjectURL(file);
});

removeProfilePic.addEventListener("click", async () => {
  if (!(await showConfirm("Remove your profile picture?"))) return;
  profileData.picture = null;
  saveProfileData();
  updateProfileDisplay();
  profilePicPreview.src = fallbackAvatar(profileData.username || "User", "#c9952c");
});

document.getElementById("saveProfileBtn").addEventListener("click", () => {
  profileData.username = profileUsername.value.trim();
  saveProfileData();
  updateProfileDisplay();
  profileModal.close();
});

cancelProfile.addEventListener("click", () => {
  profileModal.close();
});

switchAccountBtn.addEventListener("click", () => {
  profileModal.close();
  if (typeof google === "undefined" || !google.accounts) {
    showAlert("Error", "Google SDK not loaded yet. Try again in a moment.");
    return;
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: "openid email profile",
    prompt: "select_account",
    callback: async (tokenResponse) => {
      if (!tokenResponse || !tokenResponse.access_token) return;
      try {
        const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
        });
        const data = await res.json();
        if (data.id) {
          currentUser = { id: data.id, name: data.name, email: data.email, picture: data.picture };
          localStorage.setItem("sceneai_user", JSON.stringify(currentUser));
          await loadProfileData();
          settings = loadSettings();
          applyTheme(settings.theme);
          applyMsgColor(settings.msgColor || "#c9952c");
          fetchAndRenderThemes();
          if (!profileData.username) {
            profileData.username = generateRandomUsername();
            saveProfileData();
          }
          await checkAdmin();
          await checkSubscription();
          applyAdminUI();
          await refreshCharacters();
          showUserMenu();
          location.reload();
        }
      } catch (err) {
        console.error("Failed to get user info:", err);
      }
    }
  });
  tokenClient.requestAccessToken();
});

logoutBtn.addEventListener("click", () => {
  profileModal.close();
  localStorage.removeItem("sceneai_user");
  location.reload();
});

deleteAccountBtn.addEventListener("click", async () => {
  if (!(await showConfirm("Are you sure you want to delete your account?\n\nYou will permanently lose:\n- Your profile and username\n- All your coins and subscription\n- All your conversations and messages\n- Your favorites, likes, and memories\n- All your group chats\n\nThis cannot be undone."))) return;
  try {
    await fetch(`/api/users/${currentUser.id}/messages`, { method: "DELETE" });
  } catch(e) { console.error("Failed to delete messages:", e); }
  localStorage.removeItem(`sceneai_profile_${currentUser.id}`);
  localStorage.removeItem("sceneai_user");
  currentUser = null;
  profileData = {};
  profileModal.close();
  google.accounts.id.disableAutoSelect();
  showSignIn();
});

// ── Clear History ─────────────────────────────────────────
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const clearHistoryModal = document.getElementById("clearHistoryModal");
const cancelClearHistory = document.getElementById("cancelClearHistory");
const confirmClearHistory = document.getElementById("confirmClearHistory");

clearHistoryBtn.addEventListener("click", () => {
  clearHistoryModal.showModal();
});

cancelClearHistory.addEventListener("click", () => {
  clearHistoryModal.close();
});

confirmClearHistory.addEventListener("click", async () => {
  clearHistoryModal.close();
  try {
    await fetch(`/api/users/${currentUser.id}/clear-history`, { method: "POST", headers: authHeaders() });
    currentMessages = [];
    recentChats = [];
    localStorage.removeItem(`sceneai_chats_${currentUser.id}`);
    renderRecentGallery();
    showAlert("Done", "All conversations cleared.");
  } catch(e) {
    console.error("Failed to clear history:", e);
    showAlert("Error", "Failed to clear history.");
  }
});

document.getElementById("closeSignInRequired").addEventListener("click", () => {
  document.getElementById("signInRequiredModal").close();
});

document.getElementById("closeAlertModal").addEventListener("click", () => {
  document.getElementById("alertModal").close();
});

// ── Public Profile (full-page view) ───────────────────────
const publicProfileView = document.getElementById("publicProfileView");

document.getElementById("closePublicProfileModal").addEventListener("click", () => { (previousViewFn || showGallery)(); });

async function openProfile(userId) {
  if (!userId) return;
  if (!galleryView.hidden) previousViewFn = showGallery;
  else if (!recentChatsView.hidden) previousViewFn = showRecentChats;
  else if (!favoritesView.hidden) previousViewFn = showFavorites;
  else if (!trendingView.hidden) previousViewFn = showTrending;
  else if (!mostLikedView.hidden) previousViewFn = showMostLiked;
  else if (!myCharactersView.hidden) previousViewFn = showMyCharacters;
  else if (!questsView.hidden) previousViewFn = showQuests;
  else if (!groupChatsView.hidden) previousViewFn = showGroupChats;
  chatView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = true;
  galleryView.hidden = true;
  publicProfileView.hidden = false;
  document.querySelector(".app").classList.remove("chat-active");
  document.getElementById("publicProfileUsername").textContent = "Loading...";
  document.getElementById("publicProfileBadge").textContent = "";
  document.getElementById("publicProfileBadge").className = "profile-badge";
  document.getElementById("publicProfilePicture").src = "";
  document.getElementById("publicProfileJoinDate").textContent = "";
  document.getElementById("publicProfileCharsCreated").textContent = "0";
  document.getElementById("publicProfileMsgsSent").textContent = "0";
  document.getElementById("publicProfileLikesReceived").textContent = "0";
  document.getElementById("publicProfileCharsList").innerHTML = "";
  document.getElementById("publicProfileCharsSection").style.display = "none";
  try {
    const res = await fetch(`/api/profile/${userId}/public`);
    if (!res.ok) { document.getElementById("publicProfileUsername").textContent = "Unknown user"; return; }
    const p = await res.json();
    const pic = p.picture || fallbackAvatar(p.username || "U", "#c9952c");
    document.getElementById("publicProfilePicture").src = pic;
    document.getElementById("publicProfilePicture").style.display = "";
    document.getElementById("publicProfileUsername").textContent = p.username || "Anonymous";
    const badge = document.getElementById("publicProfileBadge");
    badge.textContent = p.badge;
    badge.className = "profile-badge badge-" + p.badge.toLowerCase();
    if (p.created_at) {
      document.getElementById("publicProfileJoinDate").textContent = "Joined " + new Date(p.created_at).toLocaleDateString();
    }
    document.getElementById("publicProfileCharsCreated").textContent = p.characters_created || 0;
    document.getElementById("publicProfileMsgsSent").textContent = p.messages_sent || 0;
    document.getElementById("publicProfileLikesReceived").textContent = p.total_likes_received || 0;
    if (p.characters && p.characters.length > 0) {
      document.getElementById("publicProfileCharsSection").style.display = "";
      const list = document.getElementById("publicProfileCharsList");
      list.innerHTML = "";
      p.characters.forEach(c => {
        const card = document.createElement("div");
        card.className = "profile-char-card";
        const photoSrc = c.photo || fallbackAvatar(c.name, c.color);
        const photoStyle = c.photo_zoom != null && c.photo_zoom < 1
          ? `object-fit:contain;transform:none;`
          : `object-position:50% ${c.photo_pos != null ? c.photo_pos : 50}%;${c.photo_zoom != null && c.photo_zoom !== 1 ? 'transform:scale('+c.photo_zoom+');' : ''}`;
        card.innerHTML = `
          <img class="profile-char-photo" src="${photoSrc}" style="${photoStyle}" alt="${escapeHtml(c.name)}">
          <div class="profile-char-info">
            <p class="profile-char-name">${escapeHtml(c.name)}</p>
            ${c.tagline ? `<p class="profile-char-tagline">${escapeHtml(c.tagline)}</p>` : ""}
            <p class="profile-char-stats">${formatCount(c.like_count)} likes · ${formatCount(c.message_count)} msgs</p>
          </div>
        `;
        card.addEventListener("click", () => { profileReturnUserId = userId; openChat(c.id); });
        list.appendChild(card);
      });
    }
  } catch(e) {
    document.getElementById("publicProfileUsername").textContent = "Failed to load profile";
  }
}

// ── Group Chats ───────────────────────────────────────────
const groupChatsView = document.getElementById("groupChatsView");
const groupChatView = document.getElementById("groupChatView");
const groupChatsGalleryEl = document.getElementById("groupChatsGallery");
const groupChatsBtn = document.getElementById("groupChatsBtn");
const newGroupChatBtn = document.getElementById("newGroupChatBtn");
const groupChatModal = document.getElementById("groupChatModal");
const groupChatForm = document.getElementById("groupChatForm");
const groupChatCharSelect = document.getElementById("groupChatCharSelect");
const groupChatBackBtn = document.getElementById("groupChatBackBtn");
const groupChatMessagesEl = document.getElementById("groupChatMessages");
const groupChatComposer = document.getElementById("groupChatComposer");
const groupChatInput = document.getElementById("groupChatInput");
const groupChatSendBtn = document.getElementById("groupChatSendBtn");
const groupChatNameEl = document.getElementById("groupChatName");
const groupChatMembersEl = document.getElementById("groupChatMembers");
const groupChatAvatarsEl = document.getElementById("groupChatAvatars");
const groupChatMenuBtn = document.getElementById("groupChatMenuBtn");
const groupChatMenuDropdown = document.getElementById("groupChatMenuDropdown");
const groupChatDeleteBtn = document.getElementById("groupChatDeleteBtn");

groupChatsBtn.addEventListener("click", showGroupChats);

let groupChats = [];
let activeGroupId = null;
let activeGroupData = null;

async function loadGroupChats() {
  if (!currentUser) return [];
  try {
    const res = await fetch(`/api/group-chats?userId=${currentUser.id}`);
    if (!res.ok) throw new Error("Failed to load group chats");
    return await res.json();
  } catch(e) {
    console.error("loadGroupChats failed:", e);
    return [];
  }
}

async function createGroupChat(name, characterIds) {
  const res = await fetch("/api/group-chats", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, characterIds })
  });
  if (!res.ok) throw new Error("Failed to create group chat");
  return await res.json();
}

async function loadGroupChatMessages(groupId) {
  if (!currentUser) return [];
  try {
    const res = await fetch(`/api/group-chats/${groupId}/messages?userId=${currentUser.id}`);
    if (!res.ok) throw new Error("Failed to load messages");
    return await res.json();
  } catch(e) {
    console.error("loadGroupChatMessages failed:", e);
    return [];
  }
}

async function sendGroupChatMessage(groupId, content) {
  const res = await fetch(`/api/group-chats/${groupId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ content, username: profileData.username || (currentUser ? currentUser.name.split(" ")[0] : "User") })
  });
  if (!res.ok) throw new Error("Failed to send message");
  return await res.json();
}

async function deleteGroupChat(groupId) {
  const res = await fetch(`/api/group-chats/${groupId}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to delete group chat");
}

function buildGroupChatCard(g) {
  const card = document.createElement("button");
  card.className = "card";
  const avatarsHtml = g.members.slice(0, 4).map(m =>
    `<img class="card-photo" src="${avatarSrc(m)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:-8px;border:2px solid var(--panel);">`
  ).join("");
  const memberNames = g.members.map(m => m.name).join(", ");
  card.innerHTML = `
    <div style="height:80px;display:flex;align-items:center;justify-content:center;background:var(--panel-hover);border-bottom:1px solid var(--border);">
      <div style="display:flex;padding:0 4px;">${avatarsHtml}</div>
    </div>
    <div class="card-body">
      <p class="card-name">${escapeHtml(g.name || memberNames)}</p>
      <p class="card-desc">${escapeHtml(memberNames)}</p>
    </div>
  `;
  card.addEventListener("click", () => openGroupChat(g.id));
  return card;
}

async function renderGroupChatsGallery() {
  if (!currentUser) {
    groupChatsGalleryEl.innerHTML = `<p class="card-desc">Sign in to see your group chats.</p>`;
    return;
  }
  groupChats = await loadGroupChats();
  groupChatsGalleryEl.innerHTML = "";
  if (groupChats.length === 0) {
    groupChatsGalleryEl.innerHTML = `<p class="card-desc">No group chats yet — create one above.</p>`;
    return;
  }
  groupChats.forEach(g => groupChatsGalleryEl.appendChild(buildGroupChatCard(g)));
}

function showGroupChats() {
  activeId = null;
  chatView.hidden = true;
  galleryView.hidden = true;
  recentChatsView.hidden = true;
  favoritesView.hidden = true;
  trendingView.hidden = true;
  mostLikedView.hidden = true;
  myCharactersView.hidden = true;
  questsView.hidden = true;
  groupChatView.hidden = true;
  groupChatsView.hidden = false;
  setTab("groupChats");
  document.querySelector(".app").classList.remove("chat-active");
  renderGroupChatsGallery();
}

async function openGroupChat(groupId) {
  activeGroupId = groupId;
  activeGroupData = groupChats.find(g => g.id === groupId);
  if (!activeGroupData) return;
  const members = activeGroupData.members;
  groupChatNameEl.textContent = activeGroupData.name || members.map(m => m.name).join(", ");
  groupChatMembersEl.textContent = members.map(m => m.name).join(", ");
  groupChatAvatarsEl.innerHTML = "";
  members.slice(0, 4).forEach(m => {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.src = avatarSrc(m);
    groupChatAvatarsEl.appendChild(img);
  });
  groupChatsView.hidden = true;
  publicProfileView.hidden = true;
  groupChatView.hidden = false;
  setTab(null);
  const msgs = await loadGroupChatMessages(groupId);
  renderGroupChatMessages(msgs, members);
  groupChatInput.value = "";
  groupChatInput.focus();
}

let groupChatCurrentMessages = [];

function renderGroupChatMessages(msgs, members) {
  groupChatCurrentMessages = msgs;
  groupChatMessagesEl.innerHTML = "";
  if (msgs.length === 0) {
    groupChatMessagesEl.innerHTML = `<div class="empty-state"><p>Say hi to the group.</p></div>`;
    return;
  }
  msgs.forEach(m => {
    const wrap = document.createElement("div");
    const isUser = m.role === "user";
    wrap.className = "msg-wrap " + (isUser ? "user" : "character");
    const div = document.createElement("div");
    div.className = "msg " + (isUser ? "user" : "character");
    if (!isUser && m.character_id) {
      const char = members.find(c => c.id === m.character_id);
      if (char) {
        const nameDiv = document.createElement("div");
        nameDiv.className = "msg-char-name";
        nameDiv.style.color = char.color || "var(--accent-bright)";
        const nameImg = document.createElement("img");
        nameImg.src = avatarSrc(char);
        nameDiv.appendChild(nameImg);
        nameDiv.appendChild(document.createTextNode(char.name));
        div.appendChild(nameDiv);
      }
    }
    const textSpan = document.createElement("span");
    textSpan.innerHTML = formatMsg(m.content);
    div.appendChild(textSpan);
    wrap.appendChild(div);
    groupChatMessagesEl.appendChild(wrap);
  });
  groupChatMessagesEl.scrollTop = groupChatMessagesEl.scrollHeight;
}

groupChatBackBtn.addEventListener("click", () => {
  activeGroupId = null;
  activeGroupData = null;
  groupChatView.hidden = true;
  groupChatsView.hidden = false;
  setTab("groupChats");
  renderGroupChatsGallery();
});

groupChatComposer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requireAuth()) return;
  const text = groupChatInput.value.trim();
  if (!text || !activeGroupId || !activeGroupData) return;
  const members = activeGroupData.members;
  groupChatCurrentMessages.push({ role: "user", character_id: null, content: text, ts: Date.now() });
  renderGroupChatMessages(groupChatCurrentMessages, members);
  groupChatInput.value = "";
  groupChatInput.style.height = "auto";
  const typingEl = document.createElement("div");
  typingEl.className = "msg typing";
  typingEl.textContent = `Everyone is typing…`;
  groupChatMessagesEl.appendChild(typingEl);
  groupChatMessagesEl.scrollTop = groupChatMessagesEl.scrollHeight;
  groupChatSendBtn.disabled = true;
  groupChatInput.disabled = true;
  try {
    const data = await sendGroupChatMessage(activeGroupId, text);
    if (data.replies && data.replies.length) {
      data.replies.forEach(r => {
        groupChatCurrentMessages.push({ role: "assistant", character_id: r.character_id, content: r.content, ts: r.ts });
      });
    }
  } catch (err) {
    groupChatCurrentMessages.push({ role: "assistant", character_id: members[0].id, content: "(Something went wrong reaching the server.)", ts: Date.now() });
    console.error(err);
  } finally {
    typingEl.remove();
    groupChatSendBtn.disabled = false;
    groupChatInput.disabled = false;
    renderGroupChatMessages(groupChatCurrentMessages, members);
  }
});

groupChatInput.addEventListener("input", () => {
  groupChatInput.style.height = "auto";
  groupChatInput.style.height = Math.min(groupChatInput.scrollHeight, 140) + "px";
});

groupChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    groupChatComposer.dispatchEvent(new Event("submit"));
  }
});

groupChatMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  groupChatMenuDropdown.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".chat-header-menu")) {
    groupChatMenuDropdown.classList.remove("open");
  }
});

groupChatDeleteBtn.addEventListener("click", async () => {
  groupChatMenuDropdown.classList.remove("open");
  if (!activeGroupId) return;
  if (!(await showConfirm("Delete this group chat? This cannot be undone."))) return;
  await deleteGroupChat(activeGroupId);
  activeGroupId = null;
  activeGroupData = null;
  groupChatView.hidden = true;
  groupChatsView.hidden = false;
  setTab("groupChats");
  renderGroupChatsGallery();
});

// Group chat creation
newGroupChatBtn.addEventListener("click", () => {
  if (!requireAuth()) return;
  groupChatForm.reset();
  let selected = [];
  groupChatCharSelect.innerHTML = "";
  characters.forEach(c => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-chat-char-option";
    btn.dataset.charId = c.id;
    btn.innerHTML = `<img src="${avatarSrc(c)}" alt=""> ${escapeHtml(c.name)}`;
    btn.addEventListener("click", () => {
      const idx = selected.indexOf(c.id);
      if (idx > -1) {
        selected.splice(idx, 1);
        btn.classList.remove("selected");
      } else {
        selected.push(c.id);
        btn.classList.add("selected");
      }
    });
    groupChatCharSelect.appendChild(btn);
  });
  groupChatModal.showModal();
});

document.getElementById("cancelGroupChat").addEventListener("click", () => groupChatModal.close());

groupChatForm.addEventListener("submit", async () => {
  const name = document.getElementById("groupChatNameInput").value.trim();
  const selected = [];
  groupChatCharSelect.querySelectorAll(".selected").forEach(el => {
    const id = el.dataset.charId;
    if (id) selected.push(id);
  });
  if (selected.length < 2) {
    showAlert("Error", "Select at least 2 characters.");
    groupChatModal.showModal();
    return;
  }
  try {
    await createGroupChat(name, selected);
    groupChatModal.close();
    renderGroupChatsGallery();
  } catch(e) {
    console.error("Failed to create group chat:", e);
    showAlert("Error", "Failed to create group chat.");
  }
});

// ── Init ──────────────────────────────────────────────────
async function init() {
  // Age gate
  if (!localStorage.getItem("sceneai_age_verified")) {
    const gate = document.getElementById("ageGate");
    gate.showModal();
    document.getElementById("ageYes").addEventListener("click", () => {
      localStorage.setItem("sceneai_age_verified", "1");
      gate.close();
      init();
    });
    document.getElementById("ageNo").addEventListener("click", () => {
      gate.close();
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#999;font-family:sans-serif;text-align:center"><p>You must be 18 or older to use this site.</p></div>';
    });
    return;
  }
  handleOAuthRedirect();
  await checkAdmin();
  await checkSubscription();
  characters = shuffleArray(await loadCharacters());
  const savedTab = localStorage.getItem("sceneai_activeTab");
  const savedChat = localStorage.getItem("sceneai_activeChat");
  const tabMap = { home: showGallery, chats: showRecentChats, favorites: showFavorites, myCharacters: showMyCharacters, trending: showTrending, mostLiked: showMostLiked, quests: showQuests, groupChats: showGroupChats };
  if (savedChat && characters.find(x => x.id === savedChat)) {
    openChat(savedChat);
  } else if (savedTab && tabMap[savedTab]) {
    tabMap[savedTab]();
  } else {
    showGallery();
  }
  applyAdminUI();
  if (currentUser) {
    loadProfileData();
    showUserMenu();
    checkDailyReward();
    fetchAndRenderThemes();
  }
  initGoogleSignIn();
}

init();

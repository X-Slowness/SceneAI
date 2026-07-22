require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEYS = (process.env.GEMINI_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let apiKeyIndex = 0;
function getNextApiKey() {
  const key = API_KEYS[apiKeyIndex % API_KEYS.length];
  apiKeyIndex = (apiKeyIndex + 1) % API_KEYS.length;
  return key;
}
const MODEL = "gemini-3.1-flash-lite";
const LEMON_API_KEY = process.env.LEMON_API_KEY || "";
const LEMON_STORE_ID = process.env.LEMON_STORE_ID || "";
const LEMON_VARIANT_ID = process.env.LEMON_VARIANT_ID || "";
const LEMON_WEBHOOK_SECRET = process.env.LEMON_WEBHOOK_SECRET || "";
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

if (API_KEYS.length === 0 || !API_KEYS[0]) {
  console.warn("WARNING: No GEMINI_API_KEY set. Create a .env file (see .env.example).");
}

// ── Webhook (must be before express.json middleware) ───────
app.post("/api/webhook/lemonsqueezy", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    console.log("WEBHOOK RECEIVED:", event.meta?.event_name);
    if (event.meta?.event_name === "order_created") {
      const order = event.data;
      const custom = event.meta?.custom_data || {};
      const userId = custom.userId || custom.user_id;
      console.log("Order userId:", userId, "custom_data:", JSON.stringify(custom));
      if (userId) {
        if (custom.type === "coin_purchase" && custom.variantId) {
          const pkg = COIN_PACKAGES[parseInt(custom.variantId)];
          if (pkg) {
            ensureSubRow(userId);
            db.prepare("UPDATE subscriptions SET coins = coins + ? WHERE user_id = ?").run(pkg.coins, userId);
            console.log(`Added ${pkg.coins} coins to user ${userId}`);
            saveBackup();
          }
        } else {
          const endDate = Date.now() + 30 * 24 * 60 * 60 * 1000;
          db.prepare(`INSERT INTO subscriptions (user_id, tier, lemon_order_id, lemon_subscription_id, current_period_end, created_at)
            VALUES (?, 'subscriber', ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET tier = 'subscriber', lemon_order_id = ?, lemon_subscription_id = ?, current_period_end = ?`)
            .run(userId, order.id, order.id, endDate, Date.now(), order.id, order.id, endDate);
          console.log("Activated subscription for user:", userId);
          saveBackup();
        }
      } else {
        console.log("No userId found in custom_data");
      }
    }
    if (event.meta?.event_name === "subscription_cancelled") {
      const sub = event.data;
      db.prepare("UPDATE subscriptions SET tier = 'free' WHERE lemon_subscription_id = ?").run(sub.id);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("LemonSqueezy webhook error:", err);
    res.sendStatus(200);
  }
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res, filePath) => { if (filePath.endsWith(".js") || filePath.endsWith(".css")) { res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); } } }));

// ── Admin ─────────────────────────────────────────────────
const ADMIN_USER_ID = "100595293806084428244";

function requireAdmin(req, res, next) {
  const userId = req.headers["x-user-id"];
  if (userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// Check admin status
app.get("/api/admin/check", (req, res) => {
  const userId = req.query.userId;
  res.json({ admin: userId === ADMIN_USER_ID });
});

// Admin: restore data from backup JSON
app.post("/api/admin/restore", requireAdmin, (req, res) => {
  const data = req.body;
  if (!data || !data.characters) {
    return res.status(400).json({ error: "Invalid backup data." });
  }
  try {
    const restore = db.transaction(() => {
      for (const c of data.characters) {
        db.prepare(`INSERT OR REPLACE INTO characters (id, name, tagline, color, photo, photo_pos, photo_zoom, persona, first_message, tags, like_count, message_count, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(c.id, c.name, c.tagline, c.color, c.photo || null, c.photo_pos || 50, c.photo_zoom || 1.0, c.persona, c.first_message || "", c.tags || "[]", c.like_count || 0, c.message_count || 0, c.created_by || "");
      }
      for (const m of (data.messages || [])) {
        db.prepare("INSERT OR IGNORE INTO messages (id, character_id, user_id, role, content, ts) VALUES (?, ?, ?, ?, ?, ?)")
          .run(m.id, m.character_id, m.user_id, m.role, m.content, m.ts);
      }
      for (const l of (data.likes || [])) {
        db.prepare("INSERT OR IGNORE INTO likes (character_id, user_id) VALUES (?, ?)").run(l.character_id, l.user_id);
      }
      for (const f of (data.favorites || [])) {
        db.prepare("INSERT OR IGNORE INTO favorites (character_id, user_id) VALUES (?, ?)").run(f.character_id, f.user_id);
      }
      for (const s of (data.subscriptions || [])) {
        db.prepare(`INSERT OR REPLACE INTO subscriptions (user_id, tier, lemon_order_id, lemon_subscription_id, current_period_end, longer_messages, coins, free_characters_used, streak_day, last_claim_date, daily_msg_count, daily_chars_chatted, daily_reset_date, weekly_msg_count, weekly_chars_chatted, weekly_reset_date, total_messages, characters_created, daily_likes, weekly_likes, total_likes_given, daily_streak_claimed, timezone_offset, chat_theme, owned_themes, msg_color, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(s.user_id, s.tier, s.lemon_order_id || null, s.lemon_subscription_id || null, s.current_period_end || null, s.longer_messages || 0, s.coins || 0, s.free_characters_used || 0, s.streak_day || 0, s.last_claim_date || '', s.daily_msg_count || 0, s.daily_chars_chatted || '[]', s.daily_reset_date || '', s.weekly_msg_count || 0, s.weekly_chars_chatted || '[]', s.weekly_reset_date || '', s.total_messages || 0, s.characters_created || 0, s.daily_likes || 0, s.weekly_likes || 0, s.total_likes_given || 0, s.daily_streak_claimed || 0, s.timezone_offset || 0, s.chat_theme || 'default', s.owned_themes || '["default"]', s.msg_color || '#c9952c', s.created_at);
      }
      for (const m of (data.memories || [])) {
        db.prepare("INSERT OR IGNORE INTO memories (id, character_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(m.id, m.character_id, m.user_id, m.content, m.created_at);
      }
      for (const g of (data.group_chats || [])) {
        db.prepare("INSERT OR REPLACE INTO group_chats (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
          .run(g.id, g.user_id, g.name, g.created_at);
      }
      for (const gm of (data.group_chat_members || [])) {
        db.prepare("INSERT OR IGNORE INTO group_chat_members (group_id, character_id) VALUES (?, ?)")
          .run(gm.group_id, gm.character_id);
      }
      for (const p of (data.user_profiles || [])) {
        db.prepare("INSERT OR REPLACE INTO user_profiles (user_id, username, picture, created_at) VALUES (?, ?, ?, ?)")
          .run(p.user_id, p.username, p.picture, p.created_at);
      }
      for (const q of (data.claimed_quests || [])) {
        db.prepare("INSERT OR IGNORE INTO claimed_quests (user_id, quest_id, claimed_at) VALUES (?, ?, ?)").run(q.user_id, q.quest_id, q.claimed_at);
      }
    });
    restore();
    // Remove characters that have no messages, no likes, and were not in the backup
    const backupIds = new Set(data.characters.map(c => c.id));
    const dupes = db.prepare("SELECT id, name FROM characters WHERE message_count = 0 AND like_count = 0").all();
    for (const d of dupes) {
      if (!backupIds.has(d.id)) {
        db.prepare("DELETE FROM characters WHERE id = ?").run(d.id);
      }
    }
    db.exec(`UPDATE characters SET like_count = (SELECT COUNT(*) FROM likes WHERE likes.character_id = characters.id)`);
    db.exec(`UPDATE characters SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.character_id = characters.id)`);
    saveBackup();
    res.json({ ok: true, characters: data.characters.length, messages: (data.messages || []).length, likes: (data.likes || []).length });
  } catch (e) {
    console.error("Admin restore failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Database ──────────────────────────────────────────────
const fs = require("fs");
// Always try /data first (Railway volume), then /app/data, then env var, then local
let DB_PATH;
const volPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (volPath) {
  DB_PATH = path.join(volPath, "sceneai.db");
} else if (process.env.DATABASE_PATH) {
  DB_PATH = process.env.DATABASE_PATH;
} else {
  // Try /data — if Railway volume is mounted there, it persists
  try { fs.mkdirSync("/data", { recursive: true }); } catch(e) {}
  if (fs.existsSync("/data")) {
    DB_PATH = "/data/sceneai.db";
  } else {
    DB_PATH = path.join(__dirname, "sceneai.db");
  }
}
console.log("Database path:", DB_PATH);
console.log("RAILWAY_VOLUME_MOUNT_PATH:", process.env.RAILWAY_VOLUME_MOUNT_PATH || "not set");
console.log("/data exists:", fs.existsSync("/data"));
const BACKUP_PATH = path.join(path.dirname(DB_PATH), "sceneai_backup.json");
console.log("Backup path:", BACKUP_PATH);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT DEFAULT '',
    color TEXT DEFAULT '#e2b04a',
    photo TEXT,
    photo_pos INTEGER DEFAULT 50,
    photo_zoom REAL DEFAULT 1.0,
    persona TEXT NOT NULL,
    first_message TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    like_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS likes (
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (character_id, user_id),
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS favorites (
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (character_id, user_id),
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS group_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_chat_members (
    group_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    PRIMARY KEY (group_id, character_id),
    FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    character_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT DEFAULT 'free',
    lemon_order_id TEXT,
    lemon_subscription_id TEXT,
    current_period_end INTEGER,
    longer_messages INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    picture TEXT,
    created_at INTEGER NOT NULL
  );
`);

try { db.exec("ALTER TABLE characters ADD COLUMN photo_pos INTEGER DEFAULT 50"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN first_message TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN photo_zoom REAL DEFAULT 1.0"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN like_count INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN message_count INTEGER DEFAULT 0"); } catch(e) {}

// Migrate Stripe columns to LemonSqueezy
try { db.exec("ALTER TABLE subscriptions RENAME COLUMN stripe_customer_id TO lemon_order_id"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions RENAME COLUMN stripe_subscription_id TO lemon_subscription_id"); } catch(e) {}

// Add coins system columns
try { db.exec("ALTER TABLE subscriptions ADD COLUMN coins INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN free_characters_used INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN streak_day INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN last_claim_date TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN created_by TEXT DEFAULT ''"); } catch(e) {}

// Quest tracking columns
try { db.exec("ALTER TABLE subscriptions ADD COLUMN daily_msg_count INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN daily_chars_chatted TEXT DEFAULT '[]'"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN daily_reset_date TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN weekly_msg_count INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN weekly_chars_chatted TEXT DEFAULT '[]'"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN weekly_reset_date TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN total_messages INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN characters_created INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN total_likes_given INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN total_likes_received INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN daily_likes INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN weekly_likes INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN daily_streak_claimed INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN timezone_offset INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN chat_theme TEXT DEFAULT 'default'"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN owned_themes TEXT DEFAULT '[\"default\"]'"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN msg_color TEXT DEFAULT '#c9952c'"); } catch(e) {}

// Seed like_count from likes table for any characters that have 0 but should have more
db.exec(`UPDATE characters SET like_count = (SELECT COUNT(*) FROM likes WHERE likes.character_id = characters.id) WHERE like_count = 0 AND id IN (SELECT character_id FROM likes)`);
// Seed message_count from messages table
db.exec(`UPDATE characters SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.character_id = characters.id) WHERE message_count = 0 AND id IN (SELECT character_id FROM messages)`);

// ── Quests System ──────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS claimed_quests (
  user_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id)
)`);

const QUESTS = [
  { id: "daily_3_chats", category: "daily", name: "Social Butterfly", desc: "Chat with 3 different characters", target: 3, field: "daily_chars_chatted", reward: 50 },
  { id: "daily_10_msgs", category: "daily", name: "Chatterbox", desc: "Send 10 messages", target: 10, field: "daily_msg_count", reward: 40 },
  { id: "daily_2_likes", category: "daily", name: "Fan Favorite", desc: "Like 2 characters", target: 2, field: "daily_likes", reward: 30 },
  { id: "daily_streak", category: "daily", name: "Dedicated", desc: "Claim your daily login reward", target: 1, field: "daily_streak_claimed", reward: 25 },
  { id: "weekly_15_chats", category: "weekly", name: "Conversationalist", desc: "Chat with 15 different characters", target: 15, field: "weekly_chars_chatted", reward: 200 },
  { id: "weekly_75_msgs", category: "weekly", name: "Wordsmith", desc: "Send 75 messages", target: 75, field: "weekly_msg_count", reward: 150 },
  { id: "weekly_10_likes", category: "weekly", name: "Tastemaker", desc: "Like 10 characters", target: 10, field: "weekly_likes", reward: 120 },
  { id: "once_first_char", category: "one_time", name: "Creator", desc: "Create your first character", target: 1, field: "characters_created", reward: 300 },
  { id: "once_50_msgs", category: "one_time", name: "Veteran", desc: "Send 50 messages total", target: 50, field: "total_messages", reward: 200 },
  { id: "once_200_msgs", category: "one_time", name: "Legend", desc: "Send 200 messages total", target: 200, field: "total_messages", reward: 500 },
  { id: "once_5_chars", category: "one_time", name: "World Builder", desc: "Create 5 characters", target: 5, field: "characters_created", reward: 400 },
];

function ensureQuestRow(userId) {
  db.prepare(`INSERT INTO subscriptions (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`).run(userId, Date.now());
}

function getLocalDate(tzOffset) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const local = new Date(utc + tzOffset * 60000);
  return local.toISOString().slice(0, 10);
}

function getWeekStartLocal(dateStr, tzOffset) {
  const d = new Date(dateStr + "T00:00:00Z");
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const local = new Date(utc + tzOffset * 60000);
  const day = local.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  local.setUTCDate(local.getUTCDate() - diff);
  return local.toISOString().slice(0, 10);
}

function resetQuestCounters(userId, sub) {
  const tzOffset = sub.timezone_offset || 0;
  const today = getLocalDate(tzOffset);
  const weekStart = getWeekStartLocal(today, tzOffset);
  const updates = {};
  if (sub.daily_reset_date !== today) {
    updates.daily_msg_count = 0;
    updates.daily_chars_chatted = "[]";
    updates.daily_likes = 0;
    updates.daily_streak_claimed = 0;
    updates.daily_reset_date = today;
  }
  if (sub.weekly_reset_date !== weekStart) {
    updates.weekly_msg_count = 0;
    updates.weekly_chars_chatted = "[]";
    updates.weekly_likes = 0;
    updates.weekly_reset_date = weekStart;
  }
  if (Object.keys(updates).length > 0) {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(", ");
    const vals = Object.values(updates);
    db.prepare(`UPDATE subscriptions SET ${setClauses} WHERE user_id = ?`).run(...vals, userId);
    return { ...sub, ...updates };
  }
  return sub;
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function trackQuestProgress(userId, field, value) {
  ensureQuestRow(userId);
  if (field === "daily_msg_count") {
    db.prepare(`UPDATE subscriptions SET daily_msg_count = daily_msg_count + 1, weekly_msg_count = weekly_msg_count + 1, total_messages = total_messages + 1 WHERE user_id = ?`).run(userId);
  } else if (field === "daily_likes") {
    db.prepare(`UPDATE subscriptions SET daily_likes = daily_likes + 1, weekly_likes = weekly_likes + 1, total_likes_given = total_likes_given + 1 WHERE user_id = ?`).run(userId);
  } else if (field === "characters_created") {
    db.prepare(`UPDATE subscriptions SET characters_created = characters_created + 1 WHERE user_id = ?`).run(userId);
  }
}

function trackCharChatted(userId, charId, sub) {
  const tzOffset = sub.timezone_offset || 0;
  const today = getLocalDate(tzOffset);
  const weekStart = getWeekStartLocal(today, tzOffset);
  let dailyChatted = JSON.parse(sub.daily_chars_chatted || "[]");
  let weeklyChatted = JSON.parse(sub.weekly_chars_chatted || "[]");
  let changed = false;
  if (!dailyChatted.includes(charId)) { dailyChatted.push(charId); changed = true; }
  if (!weeklyChatted.includes(charId)) { weeklyChatted.push(charId); changed = true; }
  if (changed) {
    db.prepare(`UPDATE subscriptions SET daily_chars_chatted = ?, weekly_chars_chatted = ? WHERE user_id = ?`)
      .run(JSON.stringify(dailyChatted), JSON.stringify(weeklyChatted), userId);
  }
  return { dailyCount: dailyChatted.length, weeklyCount: weeklyChatted.length };
}

function getQuestProgress(userId) {
  ensureQuestRow(userId);
  let sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!sub) return [];
  sub = resetQuestCounters(userId, sub);
  const claimed = db.prepare("SELECT quest_id FROM claimed_quests WHERE user_id = ?").all(userId).map(r => r.quest_id);
  return QUESTS.map(q => {
    let progress = 0;
    if (q.field === "daily_chars_chatted") {
      progress = JSON.parse(sub.daily_chars_chatted || "[]").length;
    } else if (q.field === "weekly_chars_chatted") {
      progress = JSON.parse(sub.weekly_chars_chatted || "[]").length;
    } else {
      progress = sub[q.field] || 0;
    }
    const complete = progress >= q.target;
    const isClaimed = claimed.includes(q.id);
    return { ...q, progress: Math.min(progress, q.target), complete, claimed: isClaimed };
  });
}

// GET /api/quests
app.get("/api/quests", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });
  const tzOffset = parseInt(req.query.tz) || 0;
  ensureQuestRow(userId);
  db.prepare("UPDATE subscriptions SET timezone_offset = ? WHERE user_id = ?").run(tzOffset, userId);
  const quests = getQuestProgress(userId);
  res.json(quests);
});

// POST /api/quests/:id/claim
app.post("/api/quests/:id/claim", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const quest = QUESTS.find(q => q.id === req.params.id);
  if (!quest) return res.status(404).json({ error: "Quest not found." });
  const existing = db.prepare("SELECT 1 FROM claimed_quests WHERE user_id = ? AND quest_id = ?").get(userId, quest.id);
  if (existing) return res.status(400).json({ error: "Already claimed." });
  ensureQuestRow(userId);
  let sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!sub) return res.status(400).json({ error: "No subscription row." });
  sub = resetQuestCounters(userId, sub);
  let progress = 0;
  if (quest.field === "daily_chars_chatted") progress = JSON.parse(sub.daily_chars_chatted || "[]").length;
  else if (quest.field === "weekly_chars_chatted") progress = JSON.parse(sub.weekly_chars_chatted || "[]").length;
  else progress = sub[quest.field] || 0;
  if (progress < quest.target) return res.status(400).json({ error: "Quest not complete." });
  db.prepare("INSERT INTO claimed_quests (user_id, quest_id, claimed_at) VALUES (?, ?, ?)").run(userId, quest.id, Date.now());
  db.prepare("UPDATE subscriptions SET coins = coins + ? WHERE user_id = ?").run(quest.reward, userId);
  saveBackup();
  const updated = db.prepare("SELECT coins FROM subscriptions WHERE user_id = ?").get(userId);
  res.json({ ok: true, reward: quest.reward, total_coins: updated.coins });
});

// ── End Quests System ──────────────────────────────────────

// Restore from backup or seed characters if DB is empty
const msgCount = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;
const charCount = db.prepare("SELECT COUNT(*) as c FROM characters").get().c;
const backupExists = fs.existsSync(BACKUP_PATH);
console.log("Startup state - chars:", charCount, "msgs:", msgCount, "backup exists:", backupExists);
let needsRestore = charCount === 0;

// Also restore if backup exists and has more data than current DB
if (!needsRestore && backupExists) {
  try {
    const stat = fs.statSync(BACKUP_PATH);
    if (stat.size > 500000) {
      // Backup is huge (has old photo data). Regenerate it small.
      console.log("Backup file too large (" + stat.size + " bytes), likely contains old photo data. Will regenerate after seed.");
      needsRestore = true;
    } else {
      const backupData = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
      const backupMsgs = (backupData.messages || []).length;
      const backupLikes = (backupData.likes || []).length;
      if (backupMsgs > msgCount || backupLikes > 0) {
        needsRestore = true;
        console.log("Backup has more data than current DB. Restoring...");
      }
    }
  } catch(e) {}
}

if (needsRestore) {
  let restored = false;
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      const stat = fs.statSync(BACKUP_PATH);
      let data;
      if (stat.size > 200000) {
        console.log("Large backup (" + (stat.size/1024).toFixed(0) + "KB). Stripping seed character photos...");
        data = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
        if (data.characters) { for (const c of data.characters) { if (!c.created_by) delete c.photo; } }
        fs.writeFileSync(BACKUP_PATH, JSON.stringify(data));
      } else {
        data = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));
      }
      if (data.characters && data.characters.length > 0) {
        let seedPhotos = {};
        try {
          const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, "seed_characters.json"), "utf8"));
          for (const s of seedData) { if (s.photo) seedPhotos[s.name] = s.photo; }
        } catch(e) {}
        const restore = db.transaction(() => {
          for (const c of data.characters) {
            db.prepare(`INSERT OR REPLACE INTO characters (id, name, tagline, color, photo, photo_pos, photo_zoom, persona, first_message, tags, like_count, message_count, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(c.id, c.name, c.tagline, c.color, c.photo || seedPhotos[c.name] || null, c.photo_pos, c.photo_zoom, c.persona, c.first_message, c.tags, c.like_count || 0, c.message_count || 0, c.created_by || "");
          }
          for (const m of (data.messages || [])) {
            db.prepare("INSERT OR IGNORE INTO messages (id, character_id, user_id, role, content, ts) VALUES (?, ?, ?, ?, ?, ?)").run(m.id, m.character_id, m.user_id, m.role, m.content, m.ts);
          }
          for (const l of (data.likes || [])) {
            db.prepare("INSERT OR IGNORE INTO likes (character_id, user_id) VALUES (?, ?)").run(l.character_id, l.user_id);
          }
          for (const f of (data.favorites || [])) {
            db.prepare("INSERT OR IGNORE INTO favorites (character_id, user_id) VALUES (?, ?)").run(f.character_id, f.user_id);
          }
          for (const s of (data.subscriptions || [])) {
            db.prepare(`INSERT OR REPLACE INTO subscriptions (user_id, tier, lemon_order_id, lemon_subscription_id, current_period_end, longer_messages, coins, free_characters_used, streak_day, last_claim_date, daily_msg_count, daily_chars_chatted, daily_reset_date, weekly_msg_count, weekly_chars_chatted, weekly_reset_date, total_messages, characters_created, daily_likes, weekly_likes, total_likes_given, daily_streak_claimed, timezone_offset, chat_theme, owned_themes, msg_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(s.user_id, s.tier, s.lemon_order_id || null, s.lemon_subscription_id || null, s.current_period_end || null, s.longer_messages || 0, s.coins || 0, s.free_characters_used || 0, s.streak_day || 0, s.last_claim_date || '', s.daily_msg_count || 0, s.daily_chars_chatted || '[]', s.daily_reset_date || '', s.weekly_msg_count || 0, s.weekly_chars_chatted || '[]', s.weekly_reset_date || '', s.total_messages || 0, s.characters_created || 0, s.daily_likes || 0, s.weekly_likes || 0, s.total_likes_given || 0, s.daily_streak_claimed || 0, s.timezone_offset || 0, s.chat_theme || 'default', s.owned_themes || '["default"]', s.msg_color || '#c9952c', s.created_at);
          }
          for (const m of (data.memories || [])) {
            db.prepare("INSERT OR IGNORE INTO memories (id, character_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)").run(m.id, m.character_id, m.user_id, m.content, m.created_at);
          }
          for (const g of (data.group_chats || [])) {
            db.prepare("INSERT OR REPLACE INTO group_chats (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(g.id, g.user_id, g.name, g.created_at);
          }
          for (const gm of (data.group_chat_members || [])) {
            db.prepare("INSERT OR IGNORE INTO group_chat_members (group_id, character_id) VALUES (?, ?)").run(gm.group_id, gm.character_id);
          }
          for (const p of (data.user_profiles || [])) {
            db.prepare("INSERT OR REPLACE INTO user_profiles (user_id, username, picture, created_at) VALUES (?, ?, ?, ?)").run(p.user_id, p.username, p.picture, p.created_at);
          }
          for (const q of (data.claimed_quests || [])) {
            db.prepare("INSERT OR IGNORE INTO claimed_quests (user_id, quest_id, claimed_at) VALUES (?, ?, ?)").run(q.user_id, q.quest_id, q.claimed_at);
          }
        });
        restore();
        db.exec(`UPDATE characters SET like_count = (SELECT COUNT(*) FROM likes WHERE likes.character_id = characters.id)`);
        db.exec(`UPDATE characters SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.character_id = characters.id)`);
        console.log("Restored:", data.characters.length, "chars,", (data.messages || []).length, "msgs");
        restored = true;
      }
    }
  } catch (e) {
    console.error("Backup restore failed:", e.message);
  }

  // Fall back to seed_characters.json if no backup
  if (!restored) {
    try {
      const seedData = JSON.parse(fs.readFileSync(path.join(__dirname, "seed_characters.json"), "utf8"));
      const insert = db.prepare(
        "INSERT INTO characters (id, name, tagline, color, photo, photo_pos, photo_zoom, persona, first_message, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const seed = db.transaction(() => {
        for (const c of seedData) {
          insert.run(crypto.randomUUID(), c.name, c.tagline, c.color, c.photo, c.photoPos ?? 50, c.photoZoom ?? 1.0, c.persona, c.firstMessage, JSON.stringify(c.tags));
        }
      });
      seed();
      console.log("Seeded", seedData.length, "characters from seed_characters.json.");
    } catch (e) {
      console.error("Failed to load seed_characters.json:", e.message);
    }
  }
}

// Recover subscriptions from LemonSqueezy on startup
(async () => {
  if (!LEMON_API_KEY) return;
  try {
    const res = await fetch("https://api.lemonsqueezy.com/v1/subscriptions?filter[status]=active", {
      headers: { "Authorization": `Bearer ${LEMON_API_KEY}`, "Accept": "application/vnd.api+json" }
    });
    const data = await res.json();
    if (!data?.data) return;
    for (const sub of data.data) {
      const attrs = sub.attributes;
      // Try to find user by lemon_order_id or lemon_subscription_id
      const existing = db.prepare("SELECT * FROM subscriptions WHERE lemon_order_id = ? OR lemon_subscription_id = ?")
        .get(sub.id, sub.id);
      if (existing && existing.tier === "subscriber") continue;
      // Find by order_id from custom_data
      if (attrs.first_order_id) {
        const byOrder = db.prepare("SELECT * FROM subscriptions WHERE lemon_order_id = ?").get(String(attrs.first_order_id));
        if (byOrder && byOrder.tier !== "subscriber") {
          const endDate = Date.now() + 90 * 24 * 60 * 60 * 1000;
          db.prepare("UPDATE subscriptions SET tier = 'subscriber', current_period_end = ?, lemon_subscription_id = ? WHERE user_id = ?")
            .run(endDate, sub.id, byOrder.user_id);
          console.log("Recovered subscription for user:", byOrder.user_id);
        }
      }
    }
  } catch (e) {
    console.error("Subscription recovery error:", e.message);
  }
})();

// ── Rate limiting ─────────────────────────────────────────
const requestLog = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT;
}

// ── Auth ──────────────────────────────────────────────────
app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: "Missing credential." });
  }
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );
    if (!response.ok) {
      return res.status(401).json({ error: "Invalid token." });
    }
    const payload = await response.json();
    res.json({
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      picture: payload.picture
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(500).json({ error: "Auth verification failed." });
  }
});

// ── User Profile (synced across devices) ──────────────────
app.get("/api/profile/:userId", (req, res) => {
  const row = db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(req.params.userId);
  res.json(row || { user_id: req.params.userId, username: null, picture: null });
});

// Public profile with stats
app.get("/api/profile/:userId/public", (req, res) => {
  const userId = req.params.userId;
  const profile = db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(userId);
  if (!profile) return res.status(404).json({ error: "Profile not found." });
  const createdChars = db.prepare("SELECT id, name, tagline, color, photo, photo_pos, photo_zoom, like_count, message_count, tags FROM characters WHERE created_by = ?").all(userId);
  const totalLikes = createdChars.reduce((sum, c) => sum + (c.like_count || 0), 0);
  const totalMsgs = createdChars.reduce((sum, c) => sum + (c.message_count || 0), 0);
  const sub = db.prepare("SELECT tier, total_messages, total_likes_given, coins FROM subscriptions WHERE user_id = ?").get(userId);
  const isAdmin = userId === ADMIN_USER_ID;
  let badge = "User";
  if (isAdmin) badge = "Admin";
  else if (sub && sub.tier === "subscriber") badge = "Pro";
  res.json({
    user_id: userId,
    username: profile.username,
    picture: profile.picture,
    created_at: profile.created_at,
    badge,
    characters_created: createdChars.length,
    total_likes_received: totalLikes,
    messages_sent: (sub && sub.total_messages) || 0,
    coins_earned: (sub && sub.coins) || 0,
    characters: createdChars.map(c => ({
      id: c.id,
      name: c.name,
      tagline: c.tagline,
      color: c.color,
      photo: c.photo,
      photo_pos: c.photo_pos,
      photo_zoom: c.photo_zoom,
      like_count: c.like_count || 0,
      message_count: c.message_count || 0,
      tags: JSON.parse(c.tags || "[]")
    }))
  });
});

app.put("/api/profile/:userId", (req, res) => {
  const { username, picture } = req.body;
  const now = Date.now();
  db.prepare(`INSERT INTO user_profiles (user_id, username, picture, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, picture = excluded.picture`).run(req.params.userId, username || null, picture || null, now);
  saveBackup();
  res.json({ ok: true });
});

// ── Characters CRUD ───────────────────────────────────────

// List all characters
app.get("/api/characters", (req, res) => {
  const userId = req.query.userId;
  const rows = db.prepare("SELECT * FROM characters").all();
  const userLikeStmt = userId ? db.prepare("SELECT 1 FROM likes WHERE character_id = ? AND user_id = ?") : null;
  const userFavStmt = userId ? db.prepare("SELECT 1 FROM favorites WHERE character_id = ? AND user_id = ?") : null;
  const creatorCache = {};
  const characters = rows.map(r => {
    let creatorName = "";
    if (r.created_by) {
      if (!(r.created_by in creatorCache)) {
        const profile = db.prepare("SELECT username FROM user_profiles WHERE user_id = ?").get(r.created_by);
        creatorCache[r.created_by] = profile ? profile.username : "";
      }
      creatorName = creatorCache[r.created_by];
    }
    return {
      ...r,
      tags: JSON.parse(r.tags || "[]"),
      history: [],
      message_count: r.message_count || 0,
      like_count: r.like_count || 0,
      liked: userLikeStmt ? !!userLikeStmt.get(r.id, userId) : false,
      favorited: userFavStmt ? !!userFavStmt.get(r.id, userId) : false,
      creator_name: creatorName
    };
  });
  res.json(characters);
});

// Get single character
app.get("/api/characters/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found." });
  const count = db.prepare("SELECT COUNT(*) as c FROM messages WHERE character_id = ?").get(req.params.id).c;
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [], message_count: row.message_count || 0 });
});

// ── Coins System ──────────────────────────────────────────
const FREE_CHAR_LIMIT = 10;
const COIN_COST_PER_CHAR = 200;

// Get coins + free uses for a user
app.get("/api/coins/:userId", (req, res) => {
  if (req.params.userId === ADMIN_USER_ID) {
    const sub = db.prepare("SELECT coins FROM subscriptions WHERE user_id = ?").get(req.params.userId);
    return res.json({ coins: (sub && sub.coins) || 0, free_characters_used: 0, free_remaining: 999999, tier: "admin", is_admin: true, is_subscriber: true, coin_cost: COIN_COST_PER_CHAR });
  }
  const row = db.prepare("SELECT coins, free_characters_used, tier FROM subscriptions WHERE user_id = ?").get(req.params.userId);
  if (!row) {
    return res.json({ coins: 0, free_characters_used: 0, free_remaining: FREE_CHAR_LIMIT, tier: "free", is_subscriber: false });
  }
  const isSub = row.tier === "subscriber";
  res.json({
    coins: row.coins || 0,
    free_characters_used: row.free_characters_used || 0,
    free_remaining: isSub ? Infinity : Math.max(0, FREE_CHAR_LIMIT - (row.free_characters_used || 0)),
    tier: row.tier,
    is_subscriber: isSub,
    coin_cost: COIN_COST_PER_CHAR
  });
});

// Add coins (for purchases)
app.post("/api/coins/:userId/add", (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount." });
  db.prepare(`INSERT INTO subscriptions (user_id, tier, coins, created_at) VALUES (?, 'free', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET coins = coins + ?`)
    .run(req.params.userId, amount, Date.now(), amount);
  saveBackup();
  const row = db.prepare("SELECT coins FROM subscriptions WHERE user_id = ?").get(req.params.userId);
  res.json({ ok: true, coins: row.coins });
});

// ── Daily Login Streak ────────────────────────────────────
const DAILY_REWARDS = [0, 50, 100, 150, 200, 250, 300, 350]; // index = streak_day

function getTodayStr(tz) {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz || "UTC" }); // YYYY-MM-DD
  } catch(e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function ensureSubRow(userId) {
  const existing = db.prepare("SELECT user_id FROM subscriptions WHERE user_id = ?").get(userId);
  if (!existing) {
    db.prepare("INSERT INTO subscriptions (user_id, tier, streak_day, last_claim_date, created_at) VALUES (?, 'free', 0, '', ?)")
      .run(userId, Date.now());
  }
}

app.get("/api/daily-reward/:userId", (req, res) => {
  const userId = req.params.userId;
  const tz = req.query.tz || "UTC";
  ensureSubRow(userId);
  if (userId === ADMIN_USER_ID) {
    return res.json({ claimable: false, streak_day: 7, reward: 0, admin: true });
  }
  const sub = db.prepare("SELECT streak_day, last_claim_date, coins FROM subscriptions WHERE user_id = ?").get(userId);
  const today = getTodayStr(tz);
  const lastClaim = sub.last_claim_date || "";
  if (lastClaim === today) {
    return res.json({ claimable: false, streak_day: sub.streak_day, reward: 0, message: "Already claimed today" });
  }
  let nextDay;
  if (!lastClaim) {
    nextDay = 1;
  } else {
    const last = new Date(lastClaim);
    const now = new Date(today);
    const diffDays = Math.round((now - last) / 86400000);
    if (diffDays === 1) {
      nextDay = sub.streak_day >= 7 ? 1 : sub.streak_day + 1;
    } else if (diffDays > 1) {
      nextDay = 1;
    } else {
      return res.json({ claimable: false, streak_day: sub.streak_day, reward: 0 });
    }
  }
  const reward = DAILY_REWARDS[nextDay] || 50;
  res.json({ claimable: true, streak_day: nextDay, reward, coins: sub.coins });
});

app.post("/api/daily-reward/claim", (req, res) => {
  const userId = req.headers["x-user-id"];
  const tz = req.headers["x-timezone"] || "UTC";
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (userId === ADMIN_USER_ID) return res.json({ ok: false, message: "Admin doesn't need rewards" });
  ensureSubRow(userId);
  const sub = db.prepare("SELECT streak_day, last_claim_date, coins FROM subscriptions WHERE user_id = ?").get(userId);
  const today = getTodayStr(tz);
  const lastClaim = sub.last_claim_date || "";
  if (lastClaim === today) return res.status(400).json({ error: "Already claimed today." });
  let nextDay;
  if (!lastClaim) {
    nextDay = 1;
  } else {
    const last = new Date(lastClaim);
    const now = new Date(today);
    const diffDays = Math.round((now - last) / 86400000);
    if (diffDays === 1) {
      nextDay = sub.streak_day >= 7 ? 1 : sub.streak_day + 1;
    } else if (diffDays > 1) {
      nextDay = 1;
    } else {
      return res.status(400).json({ error: "Cannot claim yet." });
    }
  }
  const reward = DAILY_REWARDS[nextDay] || 50;
  db.prepare("UPDATE subscriptions SET coins = coins + ?, streak_day = ?, last_claim_date = ? WHERE user_id = ?")
    .run(reward, nextDay, today, userId);
  db.prepare("UPDATE subscriptions SET daily_streak_claimed = 1 WHERE user_id = ?").run(userId);
  saveBackup();
  const updated = db.prepare("SELECT coins, streak_day FROM subscriptions WHERE user_id = ?").get(userId);
  res.json({ ok: true, streak_day: nextDay, reward, total_coins: updated.coins });
});

// Create character (admin = free, subscriber = free, free user = 10 free then 200 coins)
app.post("/api/characters", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (userId !== ADMIN_USER_ID) {
    const sub = db.prepare("SELECT tier, coins, free_characters_used FROM subscriptions WHERE user_id = ?").get(userId);
    const isSub = sub && sub.tier === "subscriber";
    if (!isSub) {
      const used = (sub && sub.free_characters_used) || 0;
      const coins = (sub && sub.coins) || 0;
      if (used >= FREE_CHAR_LIMIT && coins < COIN_COST_PER_CHAR) {
        return res.status(403).json({ error: "No free uses left. You need 200 coins to create a character.", free_remaining: 0, coins, coin_cost: COIN_COST_PER_CHAR });
      }
    }
  }
  const { name, tagline, color, photo, photoPos, photoZoom, persona, firstMessage, tags } = req.body;
  if (!name || !persona) return res.status(400).json({ error: "Name and persona required." });
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, tagline, color, photo, photo_pos, photo_zoom, persona, first_message, tags, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, tagline || "", color || "#e2b04a", photo || null, photoPos ?? 50, photoZoom ?? 1.0, persona, firstMessage || "", JSON.stringify(tags || []), userId);

  // Deduct free use or coins for non-admin, non-subscriber users
  if (userId !== ADMIN_USER_ID) {
    const sub = db.prepare("SELECT tier, coins, free_characters_used FROM subscriptions WHERE user_id = ?").get(userId);
    const isSub = sub && sub.tier === "subscriber";
    if (!isSub) {
      const used = (sub && sub.free_characters_used) || 0;
      const coins = (sub && sub.coins) || 0;
      if (used < FREE_CHAR_LIMIT) {
        db.prepare(`INSERT INTO subscriptions (user_id, tier, free_characters_used, created_at) VALUES (?, 'free', 1, ?)
          ON CONFLICT(user_id) DO UPDATE SET free_characters_used = free_characters_used + 1`).run(userId, Date.now());
      } else {
        db.prepare(`INSERT INTO subscriptions (user_id, tier, coins, created_at) VALUES (?, 'free', ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET coins = coins - ${COIN_COST_PER_CHAR}`).run(userId, 0 - COIN_COST_PER_CHAR, Date.now());
      }
      saveBackup();
    }
  }

  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(id);
  trackQuestProgress(userId, "characters_created");
  saveBackup();
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [] });
});

// Update character (admin only)
app.put("/api/characters/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  const { name, tagline, color, photo, photoPos, photoZoom, persona, firstMessage, tags } = req.body;
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  if (userId !== ADMIN_USER_ID && existing.created_by !== userId) {
    return res.status(403).json({ error: "You can only edit your own characters." });
  }
  db.prepare(
    "UPDATE characters SET name=?, tagline=?, color=?, photo=?, photo_pos=?, photo_zoom=?, persona=?, first_message=?, tags=? WHERE id=?"
  ).run(
    name ?? existing.name,
    tagline ?? existing.tagline,
    color ?? existing.color,
    photo !== undefined ? photo : existing.photo,
    photoPos !== undefined ? photoPos : (existing.photo_pos ?? 50),
    photoZoom !== undefined ? photoZoom : (existing.photo_zoom ?? 1.0),
    persona ?? existing.persona,
    firstMessage !== undefined ? firstMessage : (existing.first_message ?? ""),
    JSON.stringify(tags ?? JSON.parse(existing.tags || "[]")),
    req.params.id
  );
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  saveBackup();
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [] });
});

// Delete character (admin or creator)
app.delete("/api/characters/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  if (userId !== ADMIN_USER_ID && existing.created_by !== userId) {
    return res.status(403).json({ error: "You can only delete your own characters." });
  }
  db.prepare("DELETE FROM messages WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM favorites WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM likes WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM memories WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM characters WHERE id = ?").run(req.params.id);
  saveBackup();
  res.json({ ok: true });
});

// ── Likes ─────────────────────────────────────────────────

// Like a character
app.post("/api/characters/:id/like", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Character not found." });
  try {
    db.prepare("INSERT INTO likes (character_id, user_id) VALUES (?, ?)").run(req.params.id, userId);
    db.prepare("UPDATE characters SET like_count = like_count + 1 WHERE id = ?").run(req.params.id);
    trackQuestProgress(userId, "daily_likes");
  } catch (e) {}
  const count = db.prepare("SELECT like_count FROM characters WHERE id = ?").get(req.params.id).like_count;
  saveBackup();
  res.json({ liked: true, like_count: count });
});

// Unlike a character
app.delete("/api/characters/:id/like", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const removed = db.prepare("DELETE FROM likes WHERE character_id = ? AND user_id = ?").run(req.params.id, userId);
  if (removed.changes > 0) {
    db.prepare("UPDATE characters SET like_count = MAX(0, like_count - 1) WHERE id = ?").run(req.params.id);
  }
  const count = db.prepare("SELECT like_count FROM characters WHERE id = ?").get(req.params.id).like_count;
  res.json({ liked: false, like_count: count });
});

// ── Favorites ─────────────────────────────────────────────

// Favorite a character
app.post("/api/characters/:id/favorite", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Character not found." });
  try {
    db.prepare("INSERT INTO favorites (character_id, user_id) VALUES (?, ?)").run(req.params.id, userId);
  } catch (e) {}
  saveBackup();
  res.json({ favorited: true });
});

// Unfavorite a character
app.delete("/api/characters/:id/favorite", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  db.prepare("DELETE FROM favorites WHERE character_id = ? AND user_id = ?").run(req.params.id, userId);
  res.json({ favorited: false });
});

// ── Memories ─────────────────────────────────────────────

// Get memories for a character + user
app.get("/api/characters/:id/memories", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });
  const rows = db.prepare(
    "SELECT id, content, created_at FROM memories WHERE character_id = ? AND user_id = ? ORDER BY created_at DESC"
  ).all(req.params.id, userId);
  res.json(rows);
});

// Add a memory
app.post("/api/characters/:id/memories", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: "Content required." });
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Character not found." });
  const stmt = db.prepare(
    "INSERT INTO memories (character_id, user_id, content, created_at) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(req.params.id, userId, content.trim(), Date.now());
  saveBackup();
  res.json({ id: result.lastInsertRowid, content: content.trim(), created_at: Date.now() });
});

// Delete a memory
app.delete("/api/characters/:id/memories/:memoryId", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const removed = db.prepare("DELETE FROM memories WHERE id = ? AND character_id = ? AND user_id = ?")
    .run(req.params.memoryId, req.params.id, userId);
  if (removed.changes === 0) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
});

// ── Subscriptions ─────────────────────────────────────────

function isSubscribed(userId) {
  if (!userId) return false;
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!sub) return false;
  if (sub.tier === "free") return false;
  if (sub.current_period_end && sub.current_period_end < Date.now()) return false;
  return true;
}

function isLongerMessages(userId) {
  if (!userId) return false;
  const sub = db.prepare("SELECT longer_messages FROM subscriptions WHERE user_id = ?").get(userId);
  return sub && sub.tier !== "free" && sub.longer_messages === 1;
}

app.get("/api/subscription/status", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ tier: "free" });
  if (userId === ADMIN_USER_ID) return res.json({ tier: "subscriber", longer_messages: true });
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!sub) return res.json({ tier: "free", longer_messages: false });
  const active = sub.tier !== "free" && (!sub.current_period_end || sub.current_period_end > Date.now());
  res.json({ tier: active ? sub.tier : "free", longer_messages: sub.longer_messages === 1, current_period_end: sub.current_period_end });
});

app.post("/api/subscription/checkout", async (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (!LEMON_API_KEY || !LEMON_STORE_ID || !LEMON_VARIANT_ID) return res.status(500).json({ error: "Payment not configured yet." });
  try {
    const checkoutRes = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LEMON_API_KEY}`,
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json"
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              custom: { userId }
            },
            product_options: {
              redirect_url: SITE_URL + "?payment=success"
            }
          },
          relationships: {
            store: { data: { type: "stores", id: LEMON_STORE_ID } },
            variant: { data: { type: "variants", id: LEMON_VARIANT_ID } }
          }
        }
      })
    });
    const data = await checkoutRes.json();
    if (data?.data?.attributes?.url) {
      db.prepare(`INSERT INTO subscriptions (user_id, tier, lemon_order_id, created_at) VALUES (?, 'pending', ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET lemon_order_id = ?`).run(userId, data.data.id, Date.now(), data.data.id);
      res.json({ url: data.data.attributes.url });
    } else {
      console.error("LemonSqueezy checkout error:", data);
      res.status(500).json({ error: "Failed to create checkout." });
    }
  } catch (err) {
    console.error("LemonSqueezy checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout." });
  }
});

// ── Coin Packages ─────────────────────────────────────────
const COIN_PACKAGES = {
  1924403: { coins: 400, label: "400 Coins" },
  1924420: { coins: 1000, label: "1,000 Coins" },
  1924421: { coins: 2000, label: "2,000 Coins" },
  1924422: { coins: 3250, label: "3,250 Coins (+250 bonus)" }
};

app.post("/api/coins/checkout", async (req, res) => {
  const userId = req.headers["x-user-id"];
  const { variantId } = req.body;
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (!variantId || !COIN_PACKAGES[variantId]) return res.status(400).json({ error: "Invalid package." });
  if (!LEMON_API_KEY || !LEMON_STORE_ID) return res.status(500).json({ error: "Payment not configured." });
  try {
    const checkoutRes = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LEMON_API_KEY}`,
        "Content-Type": "application/vnd.api+json",
        "Accept": "application/vnd.api+json"
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              custom: { userId, type: "coin_purchase", variantId: String(variantId) }
            },
            product_options: {
              redirect_url: SITE_URL + "?payment=success"
            }
          },
          relationships: {
            store: { data: { type: "stores", id: LEMON_STORE_ID } },
            variant: { data: { type: "variants", id: String(variantId) } }
          }
        }
      })
    });
    const data = await checkoutRes.json();
    if (data?.data?.attributes?.url) {
      res.json({ url: data.data.attributes.url });
    } else {
      console.error("Coin checkout error:", data);
      res.status(500).json({ error: "Failed to create checkout." });
    }
  } catch (err) {
    console.error("Coin checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout." });
  }
});

app.post("/api/subscription/toggle-longer", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (!isSubscribed(userId) && userId !== ADMIN_USER_ID) return res.status(403).json({ error: "Subscription required." });
  const sub = db.prepare("SELECT longer_messages FROM subscriptions WHERE user_id = ?").get(userId);
  const newVal = sub?.longer_messages ? 0 : 1;
  db.prepare("UPDATE subscriptions SET longer_messages = ? WHERE user_id = ?").run(newVal, userId);
  res.json({ longer_messages: newVal === 1 });
});


// ── AI Character Generator ────────────────────────────────

app.post("/api/generate-character", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) return res.status(429).json({ error: "Too many requests." });

  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });

  const { concept } = req.body;
  if (!concept) return res.status(400).json({ error: "Concept required." });

  const ALLOWED_TAGS = ["Male","Female","Male POV","Female POV","Romantic","Drama","Action","Adventure","Fantasy","Isekai","Multiple Characters","Friend","Scenario","Cheating","Comedy","Gothic","Villain","Married","Roommate","Chubby","Girlfriend","Boyfriend","Enemy","Gang","Crush","Travel","Streamer","Anime","Real Life","Game","Single"];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${getNextApiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `You are a character creator. Given a short concept, generate a full character profile. Respond ONLY with valid JSON, no markdown, no code blocks.\n\nIMPORTANT: Use simple, casual, everyday English. No fancy words, no Shakespeare, no overly formal language. Write like a normal person talking. Keep it natural and easy to read.\n\nJSON schema:\n{\n  "name": "Character's full name (max 40 chars)",\n  "tagline": "Short catchy tagline (max 60 chars)",\n  "persona": "Detailed description of how the character talks, looks, their personality, quirks, backstory. Use plain casual English. 2-4 paragraphs.",\n  "first_message": "An immersive opening message in roleplay format with *asterisks* for actions. Use casual natural English. Set a scene and stay in character. 100-200 words.",\n  "tags": ["pick 2-4 from this list: ${ALLOWED_TAGS.join(", ")}"]\n}\n\nBe creative. Make characters interesting with depth and personality.` }] },
          contents: [{ role: "user", parts: [{ text: `Create a character based on this concept: "${concept}"` }] }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.9 },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini generate-character error:", errText);
      return res.status(502).json({ error: "Generation failed." });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return res.status(502).json({ error: "No character generated." });

    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const character = JSON.parse(cleaned);
    res.json(character);
  } catch (err) {
    console.error("Generate character error:", err);
    res.status(500).json({ error: "Server error during generation." });
  }
});

// ── Group Chats ───────────────────────────────────────────

// List group chats for a user
app.get("/api/group-chats", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });
  const groups = db.prepare("SELECT * FROM group_chats WHERE user_id = ? ORDER BY created_at DESC").all(userId);
  const charStmt = db.prepare("SELECT c.* FROM characters c JOIN group_chat_members m ON c.id = m.character_id WHERE m.group_id = ?");
  const countStmt = db.prepare("SELECT COUNT(*) as c FROM group_chat_messages WHERE group_id = ?");
  const result = groups.map(g => ({
    ...g,
    members: charStmt.all(g.id).map(c => ({ ...c, tags: JSON.parse(c.tags || "[]") })),
    message_count: countStmt.get(g.id).c
  }));
  res.json(result);
});

// Create a group chat
app.post("/api/group-chats", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const { name, characterIds } = req.body;
  if (!Array.isArray(characterIds) || characterIds.length < 2) return res.status(400).json({ error: "At least 2 characters required." });
  const id = crypto.randomUUID();
  const insertGroup = db.prepare("INSERT INTO group_chats (id, user_id, name, created_at) VALUES (?, ?, ?, ?)");
  const insertMember = db.prepare("INSERT INTO group_chat_members (group_id, character_id) VALUES (?, ?)");
  const txn = db.transaction(() => {
    insertGroup.run(id, userId, name || "", Date.now());
    for (const cid of characterIds) {
      insertMember.run(id, cid);
    }
  });
  txn();
  const charStmt = db.prepare("SELECT c.* FROM characters c JOIN group_chat_members m ON c.id = m.character_id WHERE m.group_id = ?");
  const members = charStmt.all(id).map(c => ({ ...c, tags: JSON.parse(c.tags || "[]") }));
  res.json({ id, user_id: userId, name: name || "", members, message_count: 0, created_at: Date.now() });
});

// Get group chat messages
app.get("/api/group-chats/:id/messages", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });
  const group = db.prepare("SELECT * FROM group_chats WHERE id = ? AND user_id = ?").get(req.params.id, userId);
  if (!group) return res.status(404).json({ error: "Not found." });
  const rows = db.prepare(
    "SELECT character_id, role, content, ts FROM group_chat_messages WHERE group_id = ? ORDER BY ts ASC"
  ).all(req.params.id);
  res.json(rows);
});

// Send a message in a group chat (get AI responses for all members)
app.post("/api/group-chats/:id/messages", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) return res.status(429).json({ error: "Too many requests." });

  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const group = db.prepare("SELECT * FROM group_chats WHERE id = ? AND user_id = ?").get(req.params.id, userId);
  if (!group) return res.status(404).json({ error: "Not found." });

  const { content, username } = req.body;
  if (!content) return res.status(400).json({ error: "Content required." });

  const userMsg = { role: "user", character_id: null, content, ts: Date.now() };
  db.prepare("INSERT INTO group_chat_messages (group_id, character_id, role, content, ts) VALUES (?, ?, ?, ?, ?)")
    .run(req.params.id, null, "user", content, userMsg.ts);

  const members = db.prepare("SELECT c.* FROM characters c JOIN group_chat_members m ON c.id = m.character_id WHERE m.group_id = ?")
    .all(req.params.id);

  const DIDASCALIES_RULE = `\n\nStyle rules: You MUST frequently use didascalies (action/narration in *asterisks*) to describe body language, facial expressions, gestures, movements, and environment. When referencing the user in didascalies, use their name (${userName}) instead of "you". Example: *turns to ${userName} and smiles* or *leans closer to ${userName}, voice dropping*. Make the scene feel alive and cinematic.`;

  const history = db.prepare("SELECT character_id, role, content, ts FROM group_chat_messages WHERE group_id = ? ORDER BY ts ASC")
    .all(req.params.id)
    .slice(-20)
    .map(m => {
      if (m.role === "user") return { role: "user", parts: [{ text: `[User]: ${m.content}` }] };
      const char = members.find(c => c.id === m.character_id);
      const name = char ? char.name : "Unknown";
      return { role: "model", parts: [{ text: `[${name}]: ${m.content}` }] };
    });

  const userName = username || "User";
  const charList = members.map(c => `- ${c.name}: ${c.persona}`).join("\n");
  const systemPrompt = `You are voicing multiple characters in a group conversation. Each character has their own personality and speaking style. When a character speaks, prefix their dialogue with [CharacterName]:. Do NOT use [CharacterName]: for the user. The user's real name is "${userName}". Use it naturally if it comes up in conversation, but don't start every message with it or force it in.

Write replies between 250 and 350 words. Be descriptive and immersive.

Rules for who replies:
- Not every character needs to reply every turn. Only characters who are present and have something to say should reply.
- If a character was told to leave, is far away, is asleep, is unconscious, or is otherwise removed from the scene, do NOT have them reply until they rejoin.
- Sometimes only one character replies. Sometimes two or three might jump in if it makes sense for the scene. Use your judgment.
- Pay attention to the conversation history. If a character is no longer in the room or hasn't been mentioned in a while, they should stay silent unless something pulls them back in.

Characters:\n${charList}${DIDASCALIES_RULE}`;

  const allHistory = [...history, { role: "user", parts: [{ text: `[User]: ${content}` }] }];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${getNextApiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: allHistory,
          generationConfig: { maxOutputTokens: 800 },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", errText);
      return res.status(502).json({ error: "AI provider error." });
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const replies = [];
    const parts = raw.split(/\[(.+?)\]:\s*/g).slice(1);
    for (let i = 0; i < parts.length; i += 2) {
      const charName = parts[i].trim();
      const charContent = (parts[i + 1] || "").trim();
      if (!charContent) continue;
      const char = members.find(c => c.name.toLowerCase() === charName.toLowerCase());
      const charId = char ? char.id : members[0].id;
      const ts = Date.now() + i;
      db.prepare("INSERT INTO group_chat_messages (group_id, character_id, role, content, ts) VALUES (?, ?, ?, ?, ?)")
        .run(req.params.id, charId, "assistant", charContent, ts);
      replies.push({ character_id: charId, character_name: char ? char.name : charName, content: charContent, ts });
    }

    if (replies.length === 0 && raw.trim()) {
      const charId = members[0].id;
      const ts = Date.now();
      db.prepare("INSERT INTO group_chat_messages (group_id, character_id, role, content, ts) VALUES (?, ?, ?, ?, ?)")
        .run(req.params.id, charId, "assistant", raw.trim(), ts);
      replies.push({ character_id: charId, character_name: members[0].name, content: raw.trim(), ts });
    }

    res.json({ replies });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error contacting AI." });
  }
});

// Delete a group chat
app.delete("/api/group-chats/:id", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const group = db.prepare("SELECT * FROM group_chats WHERE id = ? AND user_id = ?").get(req.params.id, userId);
  if (!group) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM group_chat_messages WHERE group_id = ?").run(req.params.id);
  db.prepare("DELETE FROM group_chat_members WHERE group_id = ?").run(req.params.id);
  db.prepare("DELETE FROM group_chats WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ── Messages (per user per character) ─────────────────────

// Get messages for a character + user
app.get("/api/characters/:id/messages", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required." });
  const rows = db.prepare(
    "SELECT role, content, ts FROM messages WHERE character_id = ? AND user_id = ? ORDER BY ts ASC"
  ).all(req.params.id, userId);
  res.json(rows);
});

// Save a single message
app.post("/api/characters/:id/messages", (req, res) => {
  const { userId, role, content, ts } = req.body;
  if (!userId || !role || !content) return res.status(400).json({ error: "Missing fields." });
  const stmt = db.prepare(
    "INSERT INTO messages (character_id, user_id, role, content, ts) VALUES (?, ?, ?, ?, ?)"
  );
  stmt.run(req.params.id, userId, role, content, ts || Date.now());
  db.prepare("UPDATE characters SET message_count = message_count + 1 WHERE id = ?").run(req.params.id);
  if (role === "user") {
    ensureQuestRow(userId);
    let sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
    if (sub) {
      sub = resetQuestCounters(userId, sub);
      trackQuestProgress(userId, "daily_msg_count");
      trackCharChatted(userId, req.params.id, sub);
    }
  }
  saveBackup();
  res.json({ ok: true });
});

// Bulk replace all messages for a character + user (used when editing/deleting messages)
app.put("/api/characters/:id/messages", (req, res) => {
  const { userId, messages } = req.body;
  if (!userId || !Array.isArray(messages)) return res.status(400).json({ error: "Missing fields." });
  const del = db.prepare("DELETE FROM messages WHERE character_id = ? AND user_id = ?");
  const ins = db.prepare(
    "INSERT INTO messages (character_id, user_id, role, content, ts) VALUES (?, ?, ?, ?, ?)"
  );
  const replace = db.transaction(() => {
    del.run(req.params.id, userId);
    for (const m of messages) {
      ins.run(req.params.id, userId, m.role, m.content, m.ts || Date.now());
    }
  });
  replace();
  saveBackup();
  res.json({ ok: true });
});

// ── Clear all chat history for a user ──────────────────────
app.post("/api/users/:userId/clear-history", (req, res) => {
  const userId = req.params.userId;
  if (req.headers["x-user-id"] !== userId) return res.status(403).json({ error: "Not authorized." });
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  const userGroups = db.prepare("SELECT id FROM group_chats WHERE user_id = ?").all(userId);
  for (const g of userGroups) {
    db.prepare("DELETE FROM group_chat_messages WHERE group_id = ?").run(g.id);
  }
  res.json({ ok: true });
});

// ── Delete all data for a user (account deletion) ────────
app.delete("/api/users/:userId/messages", (req, res) => {
  const userId = req.params.userId;
  db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM favorites WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM likes WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_profiles WHERE user_id = ?").run(userId);
  const userGroups = db.prepare("SELECT id FROM group_chats WHERE user_id = ?").all(userId);
  for (const g of userGroups) {
    db.prepare("DELETE FROM group_chat_messages WHERE group_id = ?").run(g.id);
    db.prepare("DELETE FROM group_chat_members WHERE group_id = ?").run(g.id);
  }
  db.prepare("DELETE FROM group_chats WHERE user_id = ?").run(userId);
  saveBackup();
  res.json({ ok: true });
});

// ── Chat proxy ────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests, slow down a moment." });
  }

  const { persona, firstMessage, history, username, characterId, userId } = req.body;
  if (!persona || !Array.isArray(history)) {
    return res.status(400).json({ error: "Missing persona or history." });
  }

  const userName = username || "User";
  const subscribed = isSubscribed(userId);
  const longerMsgs = isLongerMessages(userId);
  const wordRange = longerMsgs ? "150 and 200" : subscribed ? "100 and 150" : "50 and 100";
  const maxTokens = longerMsgs ? 300 : subscribed ? 250 : 150;
  
  // Fetch memories for this character + user
  let memoryBlock = "";
  if (characterId && userId) {
    const memories = db.prepare(
      "SELECT content FROM memories WHERE character_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 30"
    ).all(characterId, userId);
    if (memories.length > 0) {
      memoryBlock = `\n\nImportant memories about ${userName} (use these to personalize your responses and remember past interactions):\n` +
        memories.map(m => `- ${m.content}`).join("\n");
    }
  }

  const DIDASCALIES_RULE = `\n\nStyle rules: You MUST frequently use didascalies (action/narration in *asterisks*) to describe body language, facial expressions, gestures, movements, and environment. When referencing the user in didascalies, use their name (${userName}) instead of "you". Example: *turns to ${userName} and smiles* or *leans closer to ${userName}, voice dropping*. Make the scene feel alive and cinematic.`;
  const allHistory = firstMessage
    ? [{ role: "assistant", content: firstMessage }, ...history]
    : history;
  const trimmedHistory = allHistory.slice(-20).map(m => {
    let text = m.content;
    if (m.role === "user") {
      const hints = [];
      text = text.replace(/\(([^)]+)\)/g, (match, inner) => {
        hints.push(inner.trim());
        return "";
      }).trim();
      if (hints.length > 0) {
        text += `\n[User's hidden direction (do NOT mention or reply to this, just use as context for how to respond): ${hints.join("; ")}]`;
      }
    }
    return {
      role: m.role === "user" ? "user" : "model",
      parts: [{ text }]
    };
  });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${getNextApiKey()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `The user's real name is "${userName}". Use it naturally if it comes up in conversation, but don't start every message with it or force it in.\n\nWrite replies between ${wordRange} words. Use casual, natural English — no fancy words or overly formal language. Keep it vivid but easy to read.\n\n${persona}${memoryBlock}${DIDASCALIES_RULE}` }] },
          contents: trimmedHistory,
          generationConfig: { maxOutputTokens: maxTokens },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
          ]
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", errText);
      return res.status(502).json({ error: "The AI provider returned an error." });
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "(no reply)";
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error contacting the AI provider." });
  }
});

// ── Chat Themes ──────────────────────────────────────────
const THEMES = [
  { id: "default", name: "Default", preview: "#08080a", proPrice: 0, freePrice: 0 },
  { id: "midnight", name: "Midnight", preview: "#0c0a1a", proPrice: 500, freePrice: 750 },
  { id: "ocean", name: "Ocean", preview: "#0a1520", proPrice: 500, freePrice: 750 },
  { id: "sunset", name: "Sunset", preview: "#1a0e08", proPrice: 500, freePrice: 750 },
  { id: "forest", name: "Forest", preview: "#081a0e", proPrice: 500, freePrice: 750 },
  { id: "rose", name: "Rose", preview: "#1a0a14", proPrice: 750, freePrice: 1000 },
  { id: "neon", name: "Neon", preview: "#0a0a14", proPrice: 1000, freePrice: 1500 },
  { id: "cherry", name: "Cherry", preview: "#1a0a10", proPrice: 1000, freePrice: 1500 },
  { id: "galaxy", name: "Galaxy", preview: "#0a0618", proPrice: 1500, freePrice: 2000 }
];

app.get("/api/themes", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.json({ themes: THEMES.map(t => ({ ...t, owned: t.id === "default", price: 0 })), active: "default", coins: 0, is_subscriber: false });
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  const coins = sub ? sub.coins : 0;
  const isSub = isSubscribed(userId);
  const isAdmin = userId === ADMIN_USER_ID;
  const owned = sub ? JSON.parse(sub.owned_themes || '["default"]') : ["default"];
  const active = sub ? (sub.chat_theme || "default") : "default";
  const result = THEMES.map(t => {
    const isOwned = owned.includes(t.id);
    const price = isAdmin ? 0 : (isSub ? t.proPrice : t.freePrice);
    return { id: t.id, name: t.name, preview: t.preview, owned: isOwned, price };
  });
  res.json({ themes: result, active, coins, is_subscriber: isSub, is_admin: isAdmin, msg_color: sub?.msg_color || '#c9952c' });
});

app.post("/api/themes/buy", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const { themeId } = req.body;
  if (!themeId) return res.status(400).json({ error: "themeId required." });
  const theme = THEMES.find(t => t.id === themeId);
  if (!theme) return res.status(400).json({ error: "Unknown theme." });
  if (themeId === "default") return res.status(400).json({ error: "Default theme is already free." });
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  const owned = sub ? JSON.parse(sub.owned_themes || '["default"]') : ["default"];
  if (owned.includes(themeId)) return res.status(400).json({ error: "Already owned." });
  const isSub = isSubscribed(userId);
  const isAdmin = userId === ADMIN_USER_ID;
  const price = isAdmin ? 0 : (isSub ? theme.proPrice : theme.freePrice);
  if (!isAdmin && price > 0) {
    const coins = sub ? sub.coins : 0;
    if (coins < price) return res.status(403).json({ error: `Not enough coins. Need ${price}, have ${coins}.` });
    db.prepare("UPDATE subscriptions SET coins = coins - ? WHERE user_id = ?").run(price, userId);
  }
  owned.push(themeId);
  if (!sub) {
    db.prepare("INSERT OR IGNORE INTO subscriptions (user_id, tier, owned_themes, created_at) VALUES (?, 'free', ?, ?)").run(userId, JSON.stringify(owned), Date.now());
  } else {
    db.prepare("UPDATE subscriptions SET owned_themes = ? WHERE user_id = ?").run(JSON.stringify(owned), userId);
  }
  saveBackup();
  res.json({ ok: true, owned, coins: (sub && !isAdmin) ? (sub.coins - price) : 0 });
});

app.post("/api/themes/set", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const { themeId } = req.body;
  if (!themeId) return res.status(400).json({ error: "themeId required." });
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  const owned = sub ? JSON.parse(sub.owned_themes || '["default"]') : ["default"];
  if (!owned.includes(themeId) && userId !== ADMIN_USER_ID) return res.status(403).json({ error: "Theme not owned." });
  if (userId === ADMIN_USER_ID && !owned.includes(themeId)) {
    owned.push(themeId);
    if (!sub) {
      db.prepare("INSERT OR IGNORE INTO subscriptions (user_id, tier, owned_themes, created_at) VALUES (?, 'free', ?, ?)").run(userId, JSON.stringify(owned), Date.now());
    } else {
      db.prepare("UPDATE subscriptions SET owned_themes = ? WHERE user_id = ?").run(JSON.stringify(owned), userId);
    }
  }
  db.prepare("UPDATE subscriptions SET chat_theme = ? WHERE user_id = ?").run(themeId, userId);
  saveBackup();
  res.json({ ok: true, active: themeId });
});

app.post("/api/themes/msg-color", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  const { color } = req.body;
  if (!color) return res.status(400).json({ error: "color required." });
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!sub) {
    db.prepare("INSERT OR IGNORE INTO subscriptions (user_id, tier, msg_color, created_at) VALUES (?, 'free', ?, ?)").run(userId, color, Date.now());
  } else {
    db.prepare("UPDATE subscriptions SET msg_color = ? WHERE user_id = ?").run(color, userId);
  }
  saveBackup();
  res.json({ ok: true, msg_color: color });
});

app.listen(PORT, () => {
  console.log(`SceneAI server running at http://localhost:${PORT}`);
  console.log(`Database path: ${DB_PATH}`);
});

// ── Auto-backup system ────────────────────────────────────
// Saves full DB state to JSON periodically and on exit
// Restore happens at startup (above) if DB is empty

function saveBackup() {
  try {
    const chars = db.prepare("SELECT * FROM characters").all().map(c => {
      if (c.created_by) return c;
      const { photo, ...rest } = c;
      return rest;
    });
    const data = {
      characters: chars,
      messages: db.prepare("SELECT * FROM messages").all(),
      likes: db.prepare("SELECT * FROM likes").all(),
      favorites: db.prepare("SELECT * FROM favorites").all(),
      subscriptions: db.prepare("SELECT * FROM subscriptions").all(),
      memories: db.prepare("SELECT * FROM memories").all(),
      group_chats: db.prepare("SELECT * FROM group_chats").all(),
      group_chat_members: db.prepare("SELECT * FROM group_chat_members").all(),
      user_profiles: db.prepare("SELECT * FROM user_profiles").all(),
      claimed_quests: db.prepare("SELECT * FROM claimed_quests").all(),
      saved_at: Date.now()
    };
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(data));
    console.log("DB backup saved.");
  } catch (e) {
    console.error("Backup failed:", e.message);
  }
}

// Save immediately on startup if DB has data
const charCount3 = db.prepare("SELECT COUNT(*) as c FROM characters").get().c;
if (charCount3 > 0) saveBackup();

// Auto-save every 2 minutes
setInterval(saveBackup, 2 * 60 * 1000);

// Save on exit
process.on("SIGINT", () => { saveBackup(); process.exit(); });
process.on("SIGTERM", () => { saveBackup(); process.exit(); });

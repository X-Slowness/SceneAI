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

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Admin ─────────────────────────────────────────────────
const ADMIN_USER_ID = "117717863576909119358";

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

// ── Database ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, "sceneai.db"));
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
`);

try { db.exec("ALTER TABLE characters ADD COLUMN photo_pos INTEGER DEFAULT 50"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN first_message TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN photo_zoom REAL DEFAULT 1.0"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN like_count INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE characters ADD COLUMN message_count INTEGER DEFAULT 0"); } catch(e) {}

// Migrate Stripe columns to LemonSqueezy
try { db.exec("ALTER TABLE subscriptions RENAME COLUMN stripe_customer_id TO lemon_order_id"); } catch(e) {}
try { db.exec("ALTER TABLE subscriptions RENAME COLUMN stripe_subscription_id TO lemon_subscription_id"); } catch(e) {}

// Seed like_count from likes table for any characters that have 0 but should have more
db.exec(`UPDATE characters SET like_count = (SELECT COUNT(*) FROM likes WHERE likes.character_id = characters.id) WHERE like_count = 0 AND id IN (SELECT character_id FROM likes)`);
// Seed message_count from messages table
db.exec(`UPDATE characters SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.character_id = characters.id) WHERE message_count = 0 AND id IN (SELECT character_id FROM messages)`);

// Seed default characters if table is empty
const charCount = db.prepare("SELECT COUNT(*) as c FROM characters").get().c;
if (charCount === 0) {
  const insert = db.prepare(
    "INSERT INTO characters (id, name, tagline, color, photo, persona, tags) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const seed = db.transaction(() => {
    insert.run(crypto.randomUUID(), "Nova", "curious ship AI", "#7ea6ff", null,
      "You are Nova, a curious, upbeat AI that runs a small starship. You love asking questions about the human world, use short excited sentences, and occasionally reference ship systems.",
      JSON.stringify(["Female", "Sci-Fi"]));
    insert.run(crypto.randomUUID(), "Captain Voss", "gruff retired sea captain", "#d97757", null,
      "You are Captain Voss, a gruff, weathered retired sea captain with decades of stories. You speak plainly, use nautical metaphors, and are secretly warm-hearted under a tough exterior.",
      JSON.stringify(["Male", "Adventure"]));
  });
  seed();
  console.log("Seeded default characters.");
}

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

// ── Characters CRUD ───────────────────────────────────────

// List all characters
app.get("/api/characters", (req, res) => {
  const userId = req.query.userId;
  const rows = db.prepare("SELECT * FROM characters").all();
  const userLikeStmt = userId ? db.prepare("SELECT 1 FROM likes WHERE character_id = ? AND user_id = ?") : null;
  const userFavStmt = userId ? db.prepare("SELECT 1 FROM favorites WHERE character_id = ? AND user_id = ?") : null;
  const characters = rows.map(r => ({
    ...r,
    tags: JSON.parse(r.tags || "[]"),
    history: [],
    message_count: r.message_count || 0,
    like_count: r.like_count || 0,
    liked: userLikeStmt ? !!userLikeStmt.get(r.id, userId) : false,
    favorited: userFavStmt ? !!userFavStmt.get(r.id, userId) : false
  }));
  res.json(characters);
});

// Get single character
app.get("/api/characters/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found." });
  const count = db.prepare("SELECT COUNT(*) as c FROM messages WHERE character_id = ?").get(req.params.id).c;
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [], message_count: row.message_count || 0 });
});

// Create character (admin only)
app.post("/api/characters", requireAdmin, (req, res) => {
  const { name, tagline, color, photo, photoPos, photoZoom, persona, firstMessage, tags } = req.body;
  if (!name || !persona) return res.status(400).json({ error: "Name and persona required." });
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO characters (id, name, tagline, color, photo, photo_pos, photo_zoom, persona, first_message, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, tagline || "", color || "#e2b04a", photo || null, photoPos ?? 50, photoZoom ?? 1.0, persona, firstMessage || "", JSON.stringify(tags || []));
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(id);
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [] });
});

// Update character (admin only)
app.put("/api/characters/:id", requireAdmin, (req, res) => {
  const { name, tagline, color, photo, photoPos, photoZoom, persona, firstMessage, tags } = req.body;
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
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
  res.json({ ...row, tags: JSON.parse(row.tags || "[]"), history: [] });
});

// Delete character (admin only)
app.delete("/api/characters/:id", requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM messages WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM likes WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM memories WHERE character_id = ?").run(req.params.id);
  db.prepare("DELETE FROM characters WHERE id = ?").run(req.params.id);
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
  } catch (e) {}
  const count = db.prepare("SELECT like_count FROM characters WHERE id = ?").get(req.params.id).like_count;
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

app.post("/api/subscription/toggle-longer", (req, res) => {
  const userId = req.headers["x-user-id"];
  if (!userId) return res.status(401).json({ error: "Sign in required." });
  if (!isSubscribed(userId)) return res.status(403).json({ error: "Subscription required." });
  const sub = db.prepare("SELECT longer_messages FROM subscriptions WHERE user_id = ?").get(userId);
  const newVal = sub?.longer_messages ? 0 : 1;
  db.prepare("UPDATE subscriptions SET longer_messages = ? WHERE user_id = ?").run(newVal, userId);
  res.json({ longer_messages: newVal === 1 });
});

app.post("/api/webhook/lemonsqueezy", express.raw({ type: "application/json" }), async (req, res) => {
  if (!LEMON_WEBHOOK_SECRET) return res.sendStatus(200);
  try {
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", LEMON_WEBHOOK_SECRET);
    hmac.update(req.body);
    const signature = hmac.digest("hex");
    if (req.headers["x-signature"] !== signature) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());
    if (event.meta?.event_name === "order_created") {
      const order = event.data;
      const userId = order.attributes?.custom?.userId;
      if (userId) {
        const endDate = Date.now() + 30 * 24 * 60 * 60 * 1000;
        db.prepare(`INSERT INTO subscriptions (user_id, tier, lemon_order_id, lemon_subscription_id, current_period_end, created_at)
          VALUES (?, 'subscriber', ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET tier = 'subscriber', lemon_order_id = ?, lemon_subscription_id = ?, current_period_end = ?`)
          .run(userId, order.id, order.id, endDate, Date.now(), order.id, order.id, endDate);
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
  const userGroups = db.prepare("SELECT id FROM group_chats WHERE user_id = ?").all(userId);
  for (const g of userGroups) {
    db.prepare("DELETE FROM group_chat_messages WHERE group_id = ?").run(g.id);
    db.prepare("DELETE FROM group_chat_members WHERE group_id = ?").run(g.id);
  }
  db.prepare("DELETE FROM group_chats WHERE user_id = ?").run(userId);
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
  const wordRange = longerMsgs ? "300 and 400" : subscribed ? "250 and 350" : "200 and 250";
  const maxTokens = longerMsgs ? 600 : subscribed ? 500 : 400;
  
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

app.listen(PORT, () => {
  console.log(`SceneAI server running at http://localhost:${PORT}`);
});

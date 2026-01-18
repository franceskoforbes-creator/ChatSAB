import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const PUBLIC_UPLOADS_DIR = path.join(__dirname, "public", "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_UPLOADS_DIR)) fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));

const upload = multer({ dest: UPLOADS_DIR });

// ---------------- helpers ----------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing in .env`);
  return v;
}

function readUsers() {
  const raw = fs.readFileSync(USERS_FILE, "utf-8");
  return JSON.parse(raw);
}
function writeUsers(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function safeUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}
function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- limits (YOUR APP limits) ----------
function planLimits(plan) {
  // лимиты твоего сайта (не OpenAI). Меняй как хочешь.
  if (plan === "PLUS") return { requestsPerDay: 200 };
  if (plan === "PRO") return { requestsPerDay: 1000 };
  return { requestsPerDay: 25 }; // FREE (зарегистрированный)
}
function guestLimits() {
  return { requestsPerDay: 10 }; // ГОСТЬ
}

// гостевой лимит по IP (простая версия, живёт в памяти)
const guestUsage = {}; // key: "YYYY-MM-DD|ip" -> count

function consumeGuestQuota(req) {
  const today = getTodayKey();

  // Нормализуем IP (важно!)
  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  if (Array.isArray(ip)) ip = ip[0];
  ip = String(ip).trim();
  if (!ip) ip = "unknown";

  const key = `${today}|${ip}`;

  if (!(key in guestUsage)) {
    guestUsage[key] = 0; // начинаем с 0
  }

  const lim = guestLimits().requestsPerDay;

  // Проверяем лимит ТОЛЬКО если уже использовали лимит
  if (guestUsage[key] >= lim) {
    return {
      ok: false,
      code: "APP_LIMIT",
      message: "Вы достигли гостевого лимита на сегодня. Зарегистрируйтесь, чтобы получить больше запросов.",
      retry_after_sec: 86400
    };
  }

  // Считаем запрос ТОЛЬКО ПОСЛЕ проверки
  guestUsage[key] += 1;

  return { ok: true };
}


function consumeUserQuota(user) {
  const today = getTodayKey();
  if (!user.usage) user.usage = {};
  if (!user.usage[today]) user.usage[today] = { requests: 0 };

  const lim = planLimits(user.plan).requestsPerDay;
  if (user.usage[today].requests >= lim) {
    return {
      ok: false,
      code: "APP_LIMIT",
      message: "Вы достигли лимита запросов вашего тарифа на сегодня. Попробуйте завтра или активируйте апгрейд.",
      retry_after_sec: 86400
    };
  }

  user.usage[today].requests += 1;
  return { ok: true };
}

// ---------- auth ----------
function signToken(userId) {
  const secret = requireEnv("JWT_SECRET");
  return jwt.sign({ userId }, secret, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.sab_token;
    if (!token) return res.status(401).json({ ok: false, code: "AUTH", message: "Войдите в аккаунт." });

    const secret = requireEnv("JWT_SECRET");
    const payload = jwt.verify(token, secret);

    const db = readUsers();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ ok: false, code: "AUTH", message: "Аккаунт не найден." });

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ ok: false, code: "AUTH", message: "Сессия истекла. Войдите снова." });
  }
}

function optionalAuth(req, res, next) {
  try {
    const token = req.cookies?.sab_token;
    if (!token) {
      req.user = null;
      return next();
    }
    const secret = requireEnv("JWT_SECRET");
    const payload = jwt.verify(token, secret);
    const db = readUsers();
    const user = db.users.find(u => u.id === payload.userId);
    req.user = user || null;
    return next();
  } catch {
    req.user = null;
    return next();
  }
}

// ---------- OpenAI ----------
function normalizeOpenAIError(status, detailsText) {
  const isRate =
    status === 429 ||
    /rate limit|tpm|too many requests/i.test(detailsText || "");

  if (isRate) {
    return {
      ok: false,
      code: "RATE_LIMIT",
      message: "Вы достигли лимита OpenAI на минуту. Подождите 60 секунд и попробуйте снова.",
      retry_after_sec: 60
    };
  }

  return {
    ok: false,
    code: "OPENAI_ERROR",
    message: "Ошибка сервера ИИ. Попробуйте позже.",
    details: (detailsText || "").slice(0, 1500)
  };
}

async function openaiChat({ messages, stream }) {
  const key = requireEnv("OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      stream,
      max_tokens: 1200
    })
  });

  return resp;
}

// ---------------- routes ----------------
app.get("/api/debug", (req, res) => {
  res.json({
    ok: true,
    keyExists: !!process.env.OPENAI_API_KEY,
    node: process.version
  });
});

// auth
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: "Введите username и password." });
    if (String(username).length < 3) return res.status(400).json({ ok: false, message: "Username минимум 3 символа." });
    if (String(password).length < 4) return res.status(400).json({ ok: false, message: "Password минимум 4 символа." });

    const db = readUsers();
    const exists = db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
    if (exists) return res.status(400).json({ ok: false, message: "Такой username уже занят." });

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = {
      id: uid(),
      username: String(username),
      passwordHash,
      plan: "FREE",
      createdAt: Date.now(),
      usage: {}
    };

    db.users.push(user);
    writeUsers(db);

    const token = signToken(user.id);
    res.cookie("sab_token", token, { httpOnly: true, sameSite: "lax" });

    res.json({ ok: true, user: safeUser(user), limits: planLimits(user.plan) });
  } catch {
    res.status(500).json({ ok: false, message: "Ошибка регистрации." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: "Введите username и password." });

    const db = readUsers();
    const user = db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
    if (!user) return res.status(400).json({ ok: false, message: "Неверный логин или пароль." });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, message: "Неверный логин или пароль." });

    const token = signToken(user.id);
    res.cookie("sab_token", token, { httpOnly: true, sameSite: "lax" });

    res.json({ ok: true, user: safeUser(user), limits: planLimits(user.plan) });
  } catch {
    res.status(500).json({ ok: false, message: "Ошибка входа." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("sab_token");
  res.json({ ok: true });
});

app.get("/api/auth/me", optionalAuth, (req, res) => {
  // важно: теперь /me работает и для гостей
  if (!req.user) {
    return res.json({ ok: true, user: null, limits: guestLimits() });
  }
  return res.json({ ok: true, user: safeUser(req.user), limits: planLimits(req.user.plan) });
});

// upgrade (только для вошедших)
app.post("/api/profile/upgrade", authMiddleware, (req, res) => {
  const { code } = req.body || {};
  const UPGRADE_CODE = process.env.UPGRADE_CODE || "CHAT_SAB_PLUS";

  const db = readUsers();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ ok: false, message: "User not found" });

  if (String(code || "") === String(UPGRADE_CODE)) {
    user.plan = "PLUS";
    writeUsers(db);
    return res.json({ ok: true, user: safeUser(user), limits: planLimits(user.plan) });
  }

  return res.status(400).json({ ok: false, message: "Неверный код." });
});

// upload: только для вошедших (чтобы не спамили)
app.post("/api/upload", authMiddleware, upload.single("image"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, message: "No file" });

    const mime = req.file.mimetype || "image/png";
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const publicName = `${req.file.filename}.${ext}`;

    const finalPath = path.join(PUBLIC_UPLOADS_DIR, publicName);
    fs.renameSync(req.file.path, finalPath);

    const buf = fs.readFileSync(finalPath);
    const b64 = buf.toString("base64");

    res.json({
      ok: true,
      url: `/uploads/${publicName}`,
      dataUrl: `data:${mime};base64,${b64}`,
      mime
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Upload failed" });
  }
});

// chat: гостям можно
app.post("/api/chat", optionalAuth, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ ok: false, message: "messages must be array" });

    // quota
    if (req.user) {
      const db = readUsers();
      const user = db.users.find(u => u.id === req.user.id);
      if (!user) return res.status(401).json({ ok: false, code: "AUTH", message: "Аккаунт не найден." });

      const quota = consumeUserQuota(user);
      writeUsers(db);
      if (!quota.ok) {
        return res.status(429).json({ ok: false, code: quota.code, message: quota.message, retry_after_sec: quota.retry_after_sec || 60 });
      }
    } else {
      const q = consumeGuestQuota(req);
      if (!q.ok) {
        return res.status(429).json({ ok: false, code: q.code, message: q.message, retry_after_sec: q.retry_after_sec || 60 });
      }
    }

    const resp = await openaiChat({ messages, stream: false });
    if (!resp.ok) {
      const t = await resp.text();
      const err = normalizeOpenAIError(resp.status, t);
      return res.status(resp.status).json(err);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    res.json({ ok: true, content });
  } catch {
    res.status(500).json({ ok: false, code: "SERVER", message: "Ошибка сервера." });
  }
});

// stream: гостям можно
app.post("/api/chat/stream", optionalAuth, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ ok: false, message: "messages must be array" });

    // quota
    if (req.user) {
      const db = readUsers();
      const user = db.users.find(u => u.id === req.user.id);
      if (!user) return res.status(401).json({ ok: false, code: "AUTH", message: "Аккаунт не найден." });

      const quota = consumeUserQuota(user);
      writeUsers(db);
      if (!quota.ok) {
        return res.status(429).json({ ok: false, code: quota.code, message: quota.message, retry_after_sec: quota.retry_after_sec || 60 });
      }
    } else {
      const q = consumeGuestQuota(req);
      if (!q.ok) {
        return res.status(429).json({ ok: false, code: q.code, message: q.message, retry_after_sec: q.retry_after_sec || 60 });
      }
    }

    const resp = await openaiChat({ messages, stream: true });
    if (!resp.ok) {
      const t = await resp.text();
      const err = normalizeOpenAIError(resp.status, t);
      return res.status(resp.status).json(err);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
    };

    send("status", "connected");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.replace(/^data:\s*/, "");
        if (payload === "[DONE]") {
          send("done", "1");
          res.end();
          return;
        }

        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) send("token", JSON.stringify({ t: delta }));
        } catch {
          // ignore
        }
      }
    }

    send("done", "1");
    res.end();
  } catch {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Ошибка стрима." })}\n\n`);
      res.end();
    } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Chat SAB: http://localhost:${PORT}`));

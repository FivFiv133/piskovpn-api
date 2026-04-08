import Redis from "ioredis";
import crypto from "crypto";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null;
        return Math.min(times * 200, 1000);
      },
    });
    redis.on("error", (err) => console.error("[REDIS] Connection error:", err.message));
  }
  return redis;
}

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
const TOKEN_SECRET = process.env.TOKEN_SECRET || "piskovpn-secret-key-change-me";

function makeToken(user) {
  const payload = user + ":" + Date.now();
  const hmac = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  return Buffer.from(payload + ":" + hmac).toString("base64");
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const parts = decoded.split(":");
    if (parts.length < 3) return false;
    const hmac = parts.pop();
    const payload = parts.join(":");
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
    return hmac === expected;
  } catch { return false; }
}

function parseCookies(req) {
  const obj = {};
  const header = req.headers.cookie || "";
  header.split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    if (k) obj[k.trim()] = decodeURIComponent(v.join("="));
  });
  return obj;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return cookies.auth_token && verifyToken(cookies.auth_token);
}

// API: возвращает JSON-данные
async function apiData(req, res) {
  const r = getRedis();
  const allDevices = await r.hgetall("devices");
  const now = Date.now();

  const devices = [];
  let mobile = 0, desktop = 0, unknown = 0, active24h = 0, active7d = 0;
  const builds = {};

  // Собираем уникальные IP для batch geo lookup
  const ips = new Set();
  const parsed = [];
  for (const [id, raw] of Object.entries(allDevices)) {
    let info;
    try { info = JSON.parse(raw); } catch { info = { ip: "unknown", platform: "unknown", lastSeen: 0 }; }
    parsed.push({ id, info });
    if (info.ip && info.ip !== "unknown") ips.add(info.ip);
  }

  // Batch: подтягиваем geo из Redis-кеша для всех IP
  const geoMap = {};
  const geoKeys = [...ips].map(ip => `geo:${ip}`);
  if (geoKeys.length) {
    const geoValues = await r.mget(...geoKeys);
    [...ips].forEach((ip, i) => {
      if (geoValues[i]) {
        try { geoMap[ip] = JSON.parse(geoValues[i]); } catch {}
      }
    });
  }

  // Запрашиваем geo для IP без кеша (batch endpoint, до 30 за раз)
  const uncachedIps = [...ips].filter(ip => !geoMap[ip]).slice(0, 30);
  if (uncachedIps.length) {
    try {
      const resp = await fetch("http://ip-api.com/batch?fields=status,query,countryCode,city", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uncachedIps),
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      const pipeline = r.pipeline();
      for (const item of data) {
        if (item.status === "success" && item.query) {
          const geo = { country: item.countryCode || "??", city: item.city || "" };
          geoMap[item.query] = geo;
          pipeline.set(`geo:${item.query}`, JSON.stringify(geo), "EX", 86400);
        }
      }
      await pipeline.exec();
    } catch {}
  }

  for (const { id, info } of parsed) {
    const lastSeen = info.lastSeen || 0;
    const age = now - lastSeen;
    if (age < 86400000) active24h++;
    if (age < 604800000) active7d++;
    if (info.platform === "mobile") mobile++;
    else if (info.platform === "desktop") desktop++;
    else unknown++;

    const build = info.build || "unknown";
    builds[build] = (builds[build] || 0) + 1;

    devices.push({
      id,
      ip: info.ip || "unknown",
      ua: info.ua || "unknown",
      platform: info.platform || "unknown",
      build,
      geo: geoMap[info.ip] || info.geo || { country: "??", city: "" },
      lastSeen,
      lastSeenISO: lastSeen ? new Date(lastSeen).toISOString() : "never",
    });
  }

  devices.sort((a, b) => b.lastSeen - a.lastSeen);

  return res.status(200).json({
    total: devices.length, active24h, active7d,
    platforms: { mobile, desktop, unknown },
    builds,
    devices,
    version: process.env.VPN_VERSION || "v0.1.7-X",
    updated: new Date().toISOString(),
  });
}

// API: удалить устройство
async function apiDeleteDevice(req, res) {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const r = getRedis();
  await r.hdel("devices", deviceId);
  return res.status(200).json({ ok: true });
}

// API: очистить неактивные (старше N дней)
async function apiPurge(req, res) {
  const days = parseInt(req.query?.days || "30", 10);
  const r = getRedis();
  const all = await r.hgetall("devices");
  const cutoff = Date.now() - days * 86400000;
  const toRemove = [];
  for (const [id, raw] of Object.entries(all)) {
    let info;
    try { info = JSON.parse(raw); } catch { continue; }
    if ((info.lastSeen || 0) < cutoff) toRemove.push(id);
  }
  if (toRemove.length) {
    const pipeline = r.pipeline();
    toRemove.forEach(id => pipeline.hdel("devices", id));
    await pipeline.exec();
  }
  return res.status(200).json({ removed: toRemove.length });
}

// API: получить текст подписки из GitHub raw
async function apiGetSub(req, res) {
  const r = getRedis();
  const { getSubscriptionText } = await import("./subscription.js");
  const text = await getSubscriptionText(r);
  return res.status(200).json({ text });
}

// API: обновить текст подписки — пушим в GitHub + сбрасываем кеш
async function apiUpdateSub(req, res) {
  const { text } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "text required" });
  if (text.length > 500000) return res.status(400).json({ error: "text too large (max 500KB)" });
  const r = getRedis();

  // Сбрасываем кеш и сразу записываем свежий текст
  await r.set("sub_cache", text, "EX", 300);

  // Пушим в GitHub если есть токен
  let github = null;
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) {
    try {
      const repo = process.env.GITHUB_REPO || "FivFiv133/piskovpn-api";
      const path = process.env.GITHUB_FILE_PATH || "PiskoVPN.txt";
      const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;

      // Получаем текущий sha файла
      const getResp = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "PiskoVPN-Admin" },
      });
      const fileData = await getResp.json();
      const sha = fileData.sha;

      // Коммитим
      const putResp = await fetch(apiUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          "User-Agent": "PiskoVPN-Admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "Update subscription via admin panel",
          content: Buffer.from(text).toString("base64"),
          sha,
        }),
      });
      const putData = await putResp.json();
      github = putResp.ok ? { ok: true, commit: putData.commit?.sha?.slice(0, 7) } : { ok: false, error: putData.message };
    } catch (e) {
      github = { ok: false, error: e.message };
    }
  } else {
    github = { ok: false, error: "GITHUB_TOKEN не настроен" };
  }

  return res.status(200).json({ ok: github?.ok || false, github });
}

// API: проверка серверов из подписки
async function apiServers(req, res) {
  const r = getRedis();
  const { getSubscriptionText } = await import("./subscription.js");
  const text = await getSubscriptionText(r);
  const lines = text.split("\n").filter(l => l.startsWith("vless://"));
  const servers = [];
  const seen = new Set();

  for (const line of lines) {
    try {
      const match = line.match(/@([^:]+):(\d+)/);
      if (!match) continue;
      const [, host, port] = match;
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = decodeURIComponent(line.split("#").pop() || key);
      servers.push({ host, port: parseInt(port), name });
    } catch { }
  }

  // Лимит чтобы не таймаутить на Vercel
  const limited = servers.slice(0, 15);

  const net = await import("net");
  const tls = await import("tls");

  function tcpPing(host, port, timeout = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const sock = net.default.createConnection({ host, port, timeout }, () => {
        const ping = Date.now() - start;
        sock.destroy();
        resolve({ ok: true, ping });
      });
      sock.on("error", () => { sock.destroy(); resolve({ ok: false, ping: 0 }); });
      sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, ping: 0 }); });
    });
  }

  function tlsPing(host, port, timeout = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const sock = tls.default.connect({ host, port, timeout, rejectUnauthorized: false }, () => {
        const ping = Date.now() - start;
        sock.destroy();
        resolve({ ok: true, ping });
      });
      sock.on("error", () => { sock.destroy(); resolve({ ok: false, ping: 0 }); });
      sock.on("timeout", () => { sock.destroy(); resolve({ ok: false, ping: 0 }); });
    });
  }

  const results = await Promise.all(limited.map(async (s) => {
    try {
      // TLS connect — самый надёжный способ проверить vless/reality сервер
      const r = await tlsPing(s.host, s.port);
      if (r.ok) return { ...s, status: "online", ping: r.ping };
      // Fallback на TCP
      const r2 = await tcpPing(s.host, s.port);
      return { ...s, status: r2.ok ? "online" : "offline", ping: r2.ping };
    } catch {
      return { ...s, status: "offline", ping: 0 };
    }
  }));

  return res.status(200).json({ servers: results });
}

// API: график активности за 14 дней
async function apiChart(req, res) {
  const r = getRedis();
  const pipeline = r.pipeline();
  const keys = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    keys.push(key);
    pipeline.pfcount(`daily:${key}`);
  }
  const results = await pipeline.exec();
  const days = keys.map((date, i) => ({ date, count: results[i]?.[1] || 0 }));
  return res.status(200).json({ days });
}

// Главный handler
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  try {
    // Логин — не требует авторизации
    if (action === "login" && req.method === "POST") {
      const { user, pass } = req.body || {};
      if (user === ADMIN_USER && pass === ADMIN_PASS) {
        const token = makeToken(user);
        res.setHeader("Set-Cookie", `auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
        return res.status(200).json({ ok: true });
      }
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    // Логаут — не требует авторизации
    if (action === "logout") {
      res.setHeader("Set-Cookie", "auth_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send('<meta http-equiv="refresh" content="0;url=/stats">');
    }

    // Всё остальное — проверяем авторизацию
    if (!isAuthed(req)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.status(200).send(getLoginHTML());
    }

    if (action === "data") return await apiData(req, res);
    if (action === "delete" && req.method === "POST") return await apiDeleteDevice(req, res);
    if (action === "purge") return await apiPurge(req, res);
    if (action === "getSub") return await apiGetSub(req, res);
    if (action === "updateSub" && req.method === "POST") return await apiUpdateSub(req, res);
    if (action === "servers") return await apiServers(req, res);
    if (action === "chart") return await apiChart(req, res);

    // Отдаём HTML-панель
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.status(200).send(getPanelHTML());
  } catch (err) {
    console.error("[STATS] Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiskoVPN — Вход</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07060b;overflow:hidden;padding:20px}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 20%,#7c5cfc12 0%,transparent 70%),radial-gradient(ellipse 40% 40% at 80% 80%,#6d4de810 0%,transparent 60%);pointer-events:none;z-index:0}
  .particles{position:fixed;inset:0;z-index:0;overflow:hidden}
  .particles span{position:absolute;width:2px;height:2px;background:#a78bfa;border-radius:50%;animation:float linear infinite;opacity:0}
  @keyframes float{0%{transform:translateY(100vh) scale(0);opacity:0}10%{opacity:.6}90%{opacity:.6}100%{transform:translateY(-10vh) scale(1);opacity:0}}
  .login-box{position:relative;z-index:1;background:rgba(20,18,35,0.7);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(124,92,252,0.15);border-radius:24px;padding:48px 40px;width:100%;max-width:400px;text-align:center;box-shadow:0 0 60px rgba(124,92,252,0.08),0 25px 50px rgba(0,0,0,0.4);animation:fadeUp .6s ease-out}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .shield-wrap{width:72px;height:72px;margin:0 auto 20px;background:linear-gradient(135deg,#7c5cfc22,#a78bfa15);border-radius:20px;display:flex;align-items:center;justify-content:center;border:1px solid #7c5cfc25;box-shadow:0 0 30px #7c5cfc18}
  .shield-wrap svg{width:36px;height:36px;stroke:#a78bfa;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  h1{font-size:26px;font-weight:700;color:#fff;margin-bottom:4px;letter-spacing:-0.5px}
  h1 span{background:linear-gradient(135deg,#a78bfa,#7c5cfc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .sub{color:#64607a;font-size:14px;margin-bottom:32px}
  .input-wrap{position:relative;margin-bottom:16px}
  .input-wrap input{width:100%;background:rgba(15,13,26,0.6);border:1px solid rgba(124,92,252,0.12);color:#e0e0e0;padding:14px 18px 14px 46px;border-radius:14px;font-size:15px;font-family:inherit;transition:border-color .25s,box-shadow .25s}
  .input-wrap input:focus{outline:none;border-color:#7c5cfc55;box-shadow:0 0 0 3px #7c5cfc18}
  .input-wrap input::placeholder{color:#4a4660}
  .input-wrap .ico{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#4a4660;transition:color .25s}
  .input-wrap input:focus~.ico{color:#a78bfa}
  .ico svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  button[type=submit]{width:100%;background:linear-gradient(135deg,#7c5cfc,#6541e8);color:#fff;border:none;padding:14px;border-radius:14px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .25s;margin-top:6px;position:relative;overflow:hidden}
  button[type=submit]:hover{box-shadow:0 0 24px #7c5cfc44;transform:translateY(-1px)}
  button[type=submit]:active{transform:translateY(0)}
  button[type=submit]:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}
  .error-msg{color:#f87171;font-size:13px;margin-top:14px;min-height:18px;transition:opacity .2s}
  @media(max-width:480px){.login-box{padding:36px 24px;border-radius:20px}h1{font-size:22px}.shield-wrap{width:60px;height:60px;border-radius:16px}.shield-wrap svg{width:30px;height:30px}}
</style>
</head>
<body>
<div class="particles" id="pts"></div>
<div class="login-box">
  <div class="shield-wrap"><svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><rect x="10" y="10" width="4" height="5" rx="1"/><circle cx="12" cy="8" r="1.5"/></svg></div>
  <h1><span>PiskoVPN</span> Admin</h1>
  <div class="sub">Введите данные для входа</div>
  <form id="loginForm">
    <div class="input-wrap"><input type="text" id="user" placeholder="Логин" autocomplete="username" required><span class="ico"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span></div>
    <div class="input-wrap"><input type="password" id="pass" placeholder="Пароль" autocomplete="current-password" required><span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></span></div>
    <button type="submit" id="loginBtn">Войти</button>
  </form>
  <div class="error-msg" id="err"></div>
</div>
<script>
(function(){const c=document.getElementById('pts');for(let i=0;i<30;i++){const s=document.createElement('span');s.style.left=Math.random()*100+'%';s.style.animationDuration=(6+Math.random()*8)+'s';s.style.animationDelay=Math.random()*6+'s';s.style.width=s.style.height=(1+Math.random()*2)+'px';c.appendChild(s)}})();
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("loginBtn");
  const err = document.getElementById("err");
  btn.disabled = true; btn.textContent = "Вход...";
  err.textContent = "";
  try {
    const r = await fetch("/stats?action=login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: document.getElementById("user").value, pass: document.getElementById("pass").value }),
    });
    const d = await r.json();
    if (d.ok) { window.location.href = "/stats"; }
    else { err.textContent = d.error || "Ошибка входа"; btn.disabled = false; btn.textContent = "Войти"; }
  } catch(ex) { err.textContent = "Ошибка соединения"; btn.disabled = false; btn.textContent = "Войти"; }
});
</script>
</body>
</html>`;
}

function getPanelHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiskoVPN — Admin Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#07060b;color:#e0e0e0;min-height:100vh}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 40% at 50% 0%,#7c5cfc08 0%,transparent 70%);pointer-events:none;z-index:0}
  .icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;vertical-align:middle;margin-right:4px;flex-shrink:0}
  .icon svg{width:18px;height:18px}
  .icon.purple{background:linear-gradient(135deg,#7c5cfc33,#a78bfa22);box-shadow:0 0 8px #7c5cfc44;color:#a78bfa}
  .icon.green{background:linear-gradient(135deg,#34d39933,#10b98122);box-shadow:0 0 8px #34d39944;color:#34d399}
  .icon.yellow{background:linear-gradient(135deg,#fbbf2433,#f59e0b22);box-shadow:0 0 8px #fbbf2444;color:#fbbf24}
  .icon-lg{width:36px;height:36px;border-radius:10px}
  .icon-lg svg{width:22px;height:22px}
  .header{position:relative;z-index:1;background:rgba(20,18,35,0.6);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);padding:20px 30px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(124,92,252,0.1);flex-wrap:wrap;gap:12px}
  .header-left{display:flex;align-items:center;gap:12px}
  .header-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .header h1{font-size:22px;color:#fff;font-weight:700;letter-spacing:-0.5px}
  .header h1 span{background:linear-gradient(135deg,#a78bfa,#7c5cfc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .header .version{background:#7c5cfc22;color:#a78bfa;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid #7c5cfc22}
  .btn-logout{background:none;border:1px solid #f8717133;color:#f87171;padding:7px 16px;border-radius:10px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all .25s;display:inline-flex;align-items:center;gap:6px}
  .btn-logout:hover{background:#f8717115;border-color:#f87171}
  .content{position:relative;z-index:1;max-width:1440px;margin:0 auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;padding:24px 30px}
  .card{background:rgba(20,18,35,0.5);backdrop-filter:blur(12px);border:1px solid rgba(124,92,252,0.08);border-radius:16px;padding:20px;text-align:center;transition:all .3s ease}
  .card:hover{transform:translateY(-3px);border-color:rgba(124,92,252,0.25);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
  .card .card-icon{margin-bottom:8px;display:flex;justify-content:center}
  .card .num{font-size:32px;font-weight:700;color:#fff;letter-spacing:-1px}
  .card .label{font-size:12px;color:#64607a;margin-top:4px;font-weight:500}
  .card.purple .num{color:#a78bfa}
  .card.green .num{color:#34d399}
  .card.yellow .num{color:#fbbf24}
  .toolbar{padding:0 30px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
  .toolbar .search-wrap{position:relative;flex:1;min-width:180px}
  .toolbar .search-wrap .icon{position:absolute;left:8px;top:50%;transform:translateY(-50%);pointer-events:none;margin:0;background:none;box-shadow:none;color:#64607a}
  .toolbar input{background:rgba(20,18,35,0.5);backdrop-filter:blur(8px);border:1px solid rgba(124,92,252,0.1);color:#e0e0e0;padding:9px 14px 9px 40px;border-radius:10px;font-size:14px;font-family:inherit;width:100%;transition:border-color .25s,box-shadow .25s}
  .toolbar input:focus{outline:none;border-color:#7c5cfc44;box-shadow:0 0 0 3px #7c5cfc12}
  .toolbar select,.btn{background:rgba(20,18,35,0.5);backdrop-filter:blur(8px);border:1px solid rgba(124,92,252,0.1);color:#e0e0e0;padding:9px 16px;border-radius:10px;font-size:13px;font-family:inherit;cursor:pointer;transition:all .25s;font-weight:500}
  .btn{display:inline-flex;align-items:center;gap:6px}
  .btn svg{width:16px;height:16px}
  .btn:hover{border-color:#7c5cfc44;background:rgba(124,92,252,0.06)}
  .btn.danger{border-color:#f8717133;color:#f87171}
  .btn.danger:hover{background:#f8717112;border-color:#f87171}
  .btn.refresh{border-color:#34d39933;color:#34d399}
  .btn.refresh:hover{background:#34d39912;border-color:#34d399}
  .btn.del-row{border:1px solid #f8717133;color:#f87171;padding:5px 10px;font-size:12px;border-radius:8px}
  .btn.del-row:hover{background:#f8717115;border-color:#f87171}
  .btn.del-row svg{width:14px;height:14px}
  .table-wrap{padding:0 30px 30px;overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;background:rgba(20,18,35,0.5);backdrop-filter:blur(12px);border-radius:14px;overflow:hidden;border:1px solid rgba(124,92,252,0.08)}
  th{background:rgba(22,33,62,0.6);padding:12px 16px;text-align:left;font-size:11px;text-transform:uppercase;color:#64607a;letter-spacing:0.6px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap}
  th:hover{color:#a78bfa}
  th.sorted-asc::after{content:" ▲";color:#7c5cfc}
  th.sorted-desc::after{content:" ▼";color:#7c5cfc}
  td{padding:10px 16px;border-top:1px solid rgba(124,92,252,0.06);font-size:13px;white-space:nowrap}
  tr:hover td{background:rgba(124,92,252,0.03)}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:10px;font-size:12px;font-weight:600}
  .badge svg{width:14px;height:14px}
  .badge.mobile{background:#7c5cfc15;color:#a78bfa;border:1px solid #7c5cfc22}
  .badge.desktop{background:#34d39915;color:#34d399;border:1px solid #34d39922}
  .badge.unknown{background:#fbbf2415;color:#fbbf24;border:1px solid #fbbf2422}
  .status{display:inline-flex;align-items:center;gap:6px}
  .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
  .status-dot.online{background:#34d399;box-shadow:0 0 8px #34d399,0 0 16px #34d39944;animation:pulse 2s infinite}
  .status-dot.recent{background:#fbbf24;box-shadow:0 0 6px #fbbf2444}
  .status-dot.offline{background:#444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .empty{text-align:center;padding:40px;color:#64607a}
  .section{padding:0 30px 20px}
  .section-inner{background:rgba(20,18,35,0.5);backdrop-filter:blur(12px);border:1px solid rgba(124,92,252,0.08);border-radius:14px;padding:18px}
  details summary{cursor:pointer;font-size:14px;margin-bottom:12px;user-select:none;display:flex;align-items:center;gap:8px;font-weight:500}
  .footer{text-align:center;padding:20px;color:#3a3650;font-size:12px;border-top:1px solid rgba(124,92,252,0.06);font-weight:500}
  @media(max-width:768px){
    .cards{grid-template-columns:repeat(3,1fr);padding:16px;gap:10px}
    .card .num{font-size:26px}
    .toolbar{padding:0 16px 12px;gap:8px}
    .table-wrap{padding:0 16px 16px}
    .header{padding:16px}
    .section{padding:0 16px 16px}
  }
  @media(max-width:480px){
    .cards{grid-template-columns:repeat(2,1fr)}
    .card{padding:14px}
    .card .num{font-size:22px}
    .header h1{font-size:18px}
    .header-right{width:100%;justify-content:flex-end}
    .toolbar select{font-size:12px;padding:8px 10px}
  }
</style>
</head>
<body>

<svg style="display:none">
  <symbol id="i-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </symbol>
  <symbol id="i-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </symbol>
  <symbol id="i-activity" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </symbol>
  <symbol id="i-phone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
  </symbol>
  <symbol id="i-monitor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
  </symbol>
  <symbol id="i-help" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </symbol>
  <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </symbol>
  <symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </symbol>
  <symbol id="i-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </symbol>
  <symbol id="i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </symbol>
  <symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </symbol>
  <symbol id="i-save" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
  </symbol>
  <symbol id="i-tag" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
  </symbol>
  <symbol id="i-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </symbol>
  <symbol id="i-server" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
  </symbol>
  <symbol id="i-chart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
  </symbol>
</svg>

<div class="header">
  <div class="header-left">
    <span class="icon icon-lg purple"><svg><use href="#i-shield"></use></svg></span>
    <h1><span>PiskoVPN</span> Admin</h1>
  </div>
  <div class="header-right">
    <span class="version" id="ver">...</span>
    <span style="color:#666;font-size:12px" id="updated"></span>
    <a href="/health" style="background:none;border:1px solid #34d39933;color:#34d399;padding:7px 16px;border-radius:10px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;transition:all .25s;display:inline-flex;align-items:center;gap:6px;text-decoration:none" onmouseover="this.style.background='#34d39912';this.style.borderColor='#34d399'" onmouseout="this.style.background='none';this.style.borderColor='#34d39933'">
      <svg style="width:16px;height:16px"><use href="#i-activity"></use></svg> Health
    </a>
    <button class="btn-logout" onclick="location.href='/stats?action=logout'">
      <svg style="width:16px;height:16px"><use href="#i-logout"></use></svg> Выйти
    </button>
  </div>
</div>

<div class="content">
<div class="cards" id="cards"></div>

<div class="toolbar">
  <div class="search-wrap">
    <span class="icon"><svg><use href="#i-search"></use></svg></span>
    <input type="text" id="search" placeholder="Поиск по IP, платформе, User-Agent…">
  </div>
  <select id="filterPlatform">
    <option value="">Все платформы</option>
    <option value="mobile">Mobile</option>
    <option value="desktop">Desktop</option>
    <option value="unknown">Unknown</option>
  </select>
  <select id="filterStatus">
    <option value="">Все статусы</option>
    <option value="online">Online (5 мин)</option>
    <option value="recent">Недавно (24ч)</option>
    <option value="offline">Offline</option>
  </select>
  <button class="btn refresh" onclick="loadData()"><svg><use href="#i-refresh"></use></svg> Обновить</button>
  <button class="btn danger" onclick="purgeOld()"><svg><use href="#i-trash"></use></svg> Очистить 30д+</button>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th data-col="status">Статус</th>
        <th data-col="ip">IP</th>
        <th data-col="geo">Гео</th>
        <th data-col="platform">Платформа</th>
        <th data-col="ua">User-Agent</th>
        <th data-col="lastSeen">Последний визит</th>
        <th data-col="build">Build</th>
        <th>Действия</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<div class="section">
  <details>
    <summary style="color:#34d399"><span class="icon green"><svg><use href="#i-server"></use></svg></span> Серверы</summary>
    <div class="section-inner">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn refresh" onclick="loadServers()" id="pingBtn"><svg><use href="#i-refresh"></use></svg> Ping All</button>
        <span id="pingStatus" style="font-size:12px;color:#64607a"></span>
      </div>
      <div id="serversBox" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
        <span style="color:#64607a;font-size:13px">Нажмите Ping All</span>
      </div>
    </div>
  </details>
</div>

<div class="section">
  <details>
    <summary style="color:#fbbf24"><span class="icon yellow"><svg><use href="#i-chart"></use></svg></span> Активность (14 дней)</summary>
    <div class="section-inner">
      <canvas id="chartCanvas" width="800" height="200" style="width:100%;height:200px"></canvas>
    </div>
  </details>
</div>

<div class="section">
  <details>
    <summary style="color:#a78bfa"><span class="icon purple"><svg><use href="#i-edit"></use></svg></span> Редактор подписки</summary>
    <div class="section-inner">
      <textarea id="subText" style="width:100%;min-height:200px;background:rgba(10,8,20,0.6);border:1px solid rgba(124,92,252,0.1);color:#e0e0e0;padding:12px;border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:13px;resize:vertical;font-family:inherit" placeholder="Загрузка..."></textarea>
      <div style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <button class="btn refresh" onclick="saveSub()"><svg><use href="#i-save"></use></svg> Сохранить</button>
        <span id="subStatus" style="font-size:13px;color:#64607a"></span>
      </div>
    </div>
  </details>
</div>
</div>

<div class="footer">PiskoVPN Admin Panel · <span id="totalFooter">0</span> устройств</div>

<script>
const IC = {
  users: '<span class="icon icon-lg purple"><svg><use href="#i-users"></use></svg></span>',
  activity: '<span class="icon icon-lg green"><svg><use href="#i-activity"></use></svg></span>',
  calendar: '<span class="icon icon-lg yellow"><svg><use href="#i-calendar"></use></svg></span>',
  phone: '<svg style="width:14px;height:14px"><use href="#i-phone"></use></svg>',
  monitor: '<svg style="width:14px;height:14px"><use href="#i-monitor"></use></svg>',
  help: '<svg style="width:14px;height:14px"><use href="#i-help"></use></svg>',
  phoneLg: '<span class="icon icon-lg purple"><svg><use href="#i-phone"></use></svg></span>',
  monitorLg: '<span class="icon icon-lg green"><svg><use href="#i-monitor"></use></svg></span>',
  helpLg: '<span class="icon icon-lg yellow"><svg><use href="#i-help"></use></svg></span>',
};

let allDevices = [];
let sortCol = "lastSeen", sortDir = "desc";

async function loadData() {
  try {
    const r = await fetch("/stats?action=data");
    if (r.status === 401 || r.redirected) { location.href = "/stats"; return; }
    const d = await r.json();
    allDevices = d.devices || [];
    document.getElementById("ver").textContent = d.version;
    document.getElementById("updated").textContent = "Обновлено: " + new Date(d.updated).toLocaleString("ru");
    renderCards(d);
    renderTable();
  } catch(e) { console.error(e); }
}

function renderCards(d) {
  let buildsHtml = "";
  if (d.builds) {
    const entries = Object.entries(d.builds).sort((a,b) => b[1] - a[1]);
    buildsHtml = entries.map(([b,c]) => '<span class="icon icon-lg yellow"><svg><use href="#i-tag"></use></svg></span>').join("") ? 
      entries.map(([b,c]) => \`<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#ccc"><span style="color:#a78bfa;font-weight:600">\${esc(b)}</span><span style="color:#666">×\${c}</span></div>\`).join("") : "";
  }
  document.getElementById("cards").innerHTML = [
    cardH(IC.users, d.total, "Всего устройств", "purple"),
    cardH(IC.activity, d.active24h, "Активных за 24ч", "green"),
    cardH(IC.calendar, d.active7d, "Активных за 7д", "yellow"),
    cardH(IC.phoneLg, d.platforms?.mobile || 0, "Mobile", ""),
    cardH(IC.monitorLg, d.platforms?.desktop || 0, "Desktop", ""),
    cardH(IC.helpLg, d.platforms?.unknown || 0, "Unknown", ""),
  ].join("") + (buildsHtml ? \`<div class="card" style="display:flex;flex-direction:column;align-items:center"><div class="card-icon"><span class="icon icon-lg yellow"><svg><use href="#i-tag"></use></svg></span></div><div style="flex:1;display:flex;flex-wrap:wrap;gap:6px 12px;justify-content:center;align-items:center;width:100%">\${buildsHtml}</div><div class="label">Версии</div></div>\` : "");
}

function cardH(icon, num, label, cls) {
  return \`<div class="card \${cls}"><div class="card-icon">\${icon}</div><div class="num">\${num}</div><div class="label">\${label}</div></div>\`;
}

function getStatus(ts) {
  if (!ts) return "offline";
  const age = Date.now() - ts;
  if (age < 300000) return "online";
  if (age < 86400000) return "recent";
  return "offline";
}

function timeAgo(ts) {
  if (!ts) return "никогда";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + " сек назад";
  if (s < 3600) return Math.floor(s/60) + " мин назад";
  if (s < 86400) return Math.floor(s/3600) + " ч назад";
  return Math.floor(s/86400) + " д назад";
}

function platformBadge(p) {
  if (p === "mobile") return \`<span class="badge mobile">\${IC.phone} mobile</span>\`;
  if (p === "desktop") return \`<span class="badge desktop">\${IC.monitor} desktop</span>\`;
  return \`<span class="badge unknown">\${IC.help} unknown</span>\`;
}

function renderTable() {
  const search = document.getElementById("search").value.toLowerCase();
  const fp = document.getElementById("filterPlatform").value;
  const fs = document.getElementById("filterStatus").value;

  let filtered = allDevices.filter(d => {
    if (search && !((d.ip+d.ua+d.platform).toLowerCase().includes(search))) return false;
    if (fp && d.platform !== fp) return false;
    if (fs && getStatus(d.lastSeen) !== fs) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === "string") { va = va.toLowerCase(); vb = (vb||"").toLowerCase(); }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  document.querySelectorAll("th").forEach(th => {
    th.classList.remove("sorted-asc","sorted-desc");
    if (th.dataset.col === sortCol) th.classList.add("sorted-" + sortDir);
  });

  const tbody = document.getElementById("tbody");
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Нет устройств</td></tr>';
  } else {
    tbody.innerHTML = filtered.map(d => {
      const st = getStatus(d.lastSeen);
      const stLabel = st === "online" ? "Online" : st === "recent" ? "Недавно" : "Offline";
      const uaShort = d.ua.length > 60 ? d.ua.substring(0,60) + "…" : d.ua;
      const idEnc = btoa(d.id);
      return \`<tr id="row-\${idEnc}">
        <td><span class="status"><span class="status-dot \${st}"></span>\${stLabel}</span></td>
        <td>\${esc(d.ip)}</td>
        <td style="font-size:12px" title="\${esc(d.geo?.city || '')}">\${esc(d.geo?.country || '??')}\${d.geo?.city ? ' ' + esc(d.geo.city) : ''}</td>
        <td>\${platformBadge(d.platform)}</td>
        <td title="\${esc(d.ua)}">\${esc(uaShort)}</td>
        <td>\${timeAgo(d.lastSeen)}</td>
        <td><span style="color:\${d.build === 'unknown' ? '#666' : '#a78bfa'};font-size:12px;font-weight:600">\${esc(d.build)}</span></td>
        <td><button class="btn del-row" onclick="deleteDevice('\${idEnc}')"><svg><use href="#i-x"></use></svg></button></td>
      </tr>\`;
    }).join("");
  }
  document.getElementById("totalFooter").textContent = filtered.length;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

document.querySelectorAll("th[data-col]").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "asc"; }
    renderTable();
  });
});

document.getElementById("search").addEventListener("input", renderTable);
document.getElementById("filterPlatform").addEventListener("change", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

async function purgeOld() {
  if (!confirm("Удалить устройства неактивные 30+ дней?")) return;
  const r = await fetch("/stats?action=purge&days=30");
  const d = await r.json();
  alert("Удалено: " + d.removed);
  loadData();
}

async function deleteDevice(idEnc) {
  const deviceId = atob(idEnc);
  if (!confirm("Удалить это устройство?")) return;
  try {
    const r = await fetch("/stats?action=delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    const d = await r.json();
    if (d.ok) {
      const row = document.getElementById("row-" + idEnc);
      if (row) { row.style.transition = "opacity 0.3s"; row.style.opacity = "0"; setTimeout(() => loadData(), 300); }
    } else { alert("Ошибка: " + (d.error || "unknown")); }
  } catch(e) { alert("Ошибка: " + e.message); }
}

async function loadSub() {
  try {
    const r = await fetch("/stats?action=getSub");
    const d = await r.json();
    document.getElementById("subText").value = d.text || "";
  } catch(e) { console.error(e); }
}

async function saveSub() {
  const st = document.getElementById("subStatus");
  st.textContent = "Сохранение...";
  st.style.color = "#fbbf24";
  try {
    const r = await fetch("/stats?action=updateSub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: document.getElementById("subText").value }),
    });
    const d = await r.json();
    if (d.ok) {
      let msg = "✓ Сохранено в Redis";
      if (d.github) {
        msg += d.github.ok ? " + GitHub (" + d.github.commit + ")" : " (GitHub: " + d.github.error + ")";
      }
      st.textContent = msg;
      st.style.color = d.github && !d.github.ok ? "#fbbf24" : "#34d399";
    }
    else { st.textContent = "Ошибка"; st.style.color = "#f87171"; }
  } catch(e) { st.textContent = "Ошибка: " + e.message; st.style.color = "#f87171"; }
  setTimeout(() => { st.textContent = ""; }, 5000);
}

async function loadServers() {
  const box = document.getElementById("serversBox");
  const btn = document.getElementById("pingBtn");
  const st = document.getElementById("pingStatus");
  btn.disabled = true;
  st.textContent = "Пингуем...";
  st.style.color = "#fbbf24";
  box.innerHTML = '<span style="color:#666;font-size:13px">Проверяем серверы...</span>';
  try {
    const r = await fetch("/stats?action=servers");
    const d = await r.json();
    if (!d.servers?.length) { box.innerHTML = '<span style="color:#666">Нет серверов</span>'; st.textContent = ""; btn.disabled = false; return; }
    const online = d.servers.filter(s => s.status === "online").length;
    st.textContent = online + "/" + d.servers.length + " онлайн";
    st.style.color = online === d.servers.length ? "#34d399" : online > 0 ? "#fbbf24" : "#f87171";
    // Сортируем: онлайн первые, по пингу
    d.servers.sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return a.ping - b.ping;
    });
    box.innerHTML = d.servers.map(s => {
      const color = s.status === "online" ? "#34d399" : "#f87171";
      const bg = s.status === "online" ? "#34d39910" : "#f8717110";
      const border = s.status === "online" ? "#34d39933" : "#f8717133";
      const pingText = s.status === "online" ? s.ping + "ms" : "timeout";
      const pingColor = s.status !== "online" ? "#f87171" : s.ping < 200 ? "#34d399" : s.ping < 500 ? "#fbbf24" : "#f87171";
      return \`<div style="background:\${bg};border:1px solid \${border};border-radius:8px;padding:8px 12px;font-size:12px;display:flex;align-items:center;gap:8px;min-width:200px">
        <span style="width:8px;height:8px;border-radius:50%;background:\${color};flex-shrink:0\${s.status === 'online' ? ';box-shadow:0 0 6px ' + color : ''}"></span>
        <span style="color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(s.host)}">\${esc(s.name)}</span>
        <span style="color:\${pingColor};font-weight:600;font-size:11px;white-space:nowrap">\${pingText}</span>
      </div>\`;
    }).join("");
  } catch(e) { box.innerHTML = '<span style="color:#f87171">Ошибка: ' + esc(e.message) + '</span>'; st.textContent = ""; }
  btn.disabled = false;
}

async function loadChart() {
  try {
    const r = await fetch("/stats?action=chart");
    const d = await r.json();
    const canvas = document.getElementById("chartCanvas");
    if (!canvas || !d.days?.length) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = 200 * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.offsetWidth, H = 200;
    const pad = { t: 20, r: 10, b: 40, l: 40 };
    const gW = W - pad.l - pad.r, gH = H - pad.t - pad.b;
    const max = Math.max(...d.days.map(x => x.count), 1);
    const step = gW / (d.days.length - 1);

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + gH - (gH * i / 4);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#555"; ctx.font = "11px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(Math.round(max * i / 4), pad.l - 6, y + 4);
    }

    // Area fill
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + gH);
    d.days.forEach((p, i) => {
      const x = pad.l + i * step;
      const y = pad.t + gH - (p.count / max) * gH;
      i === 0 ? ctx.lineTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.l + (d.days.length - 1) * step, pad.t + gH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
    grad.addColorStop(0, "#7c5cfc33");
    grad.addColorStop(1, "#7c5cfc00");
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    d.days.forEach((p, i) => {
      const x = pad.l + i * step;
      const y = pad.t + gH - (p.count / max) * gH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Dots + labels
    d.days.forEach((p, i) => {
      const x = pad.l + i * step;
      const y = pad.t + gH - (p.count / max) * gH;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#a78bfa"; ctx.fill();
      // Date labels
      if (i % 2 === 0 || i === d.days.length - 1) {
        ctx.fillStyle = "#666"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(p.date.slice(5), x, H - pad.b + 16);
      }
    });
  } catch(e) { console.error(e); }
}

loadData();
loadSub();
loadChart();
setInterval(loadData, 30000);
</script>
</body>
</html>`;
}

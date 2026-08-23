import Redis from "ioredis";
import crypto from "crypto";
import { detectPlatform, parseClient, parseBuildFromSub, normalizeBuild } from "./device-utils.js";

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

  let currentBuild = process.env.VPN_BUILD || "65";
  try {
    const { getSubscriptionText } = await import("./subscription.js");
    const sub = await getSubscriptionText(r);
    const parsedB = parseBuildFromSub(sub);
    if (parsedB && parsedB !== "unknown") currentBuild = parsedB;
  } catch {}

  const devices = [];
  let mobile = 0, desktop = 0, unknown = 0, active24h = 0, active7d = 0, outdatedCount = 0;
  const builds = {};
  const countries = {};
  const ipCounts = {};

  // Собираем уникальные IP для batch geo lookup
  const ips = new Set();
  const parsed = [];
  for (const [id, raw] of Object.entries(allDevices)) {
    let info;
    try { info = JSON.parse(raw); } catch { info = { ip: "unknown", platform: "unknown", lastSeen: 0 }; }
    parsed.push({ id, info });
    if (info.ip && info.ip !== "unknown") {
      ips.add(info.ip);
      ipCounts[info.ip] = (ipCounts[info.ip] || 0) + 1;
    }
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

    let build = normalizeBuild(info.build || "unknown");
    if (build === "unknown") build = currentBuild;
    builds[build] = (builds[build] || 0) + 1;
    const outdated = currentBuild !== "unknown" && build !== "unknown" && build !== currentBuild;
    if (outdated) outdatedCount++;

    const ua = info.ua || "unknown";
    const client = info.client?.label ? info.client : parseClient(ua);
    const geo = geoMap[info.ip] || info.geo || { country: "??", city: "" };
    const country = geo.country || "??";
    countries[country] = (countries[country] || 0) + 1;
    const ip = info.ip || "unknown";
    const ipCount = ip !== "unknown" ? (ipCounts[ip] || 1) : 1;

    devices.push({
      id,
      ip,
      ua,
      client,
      platform: info.platform || "unknown",
      build,
      outdated,
      ipCount,
      geo,
      lastSeen,
      lastSeenISO: lastSeen ? new Date(lastSeen).toISOString() : "never",
    });
  }

  devices.sort((a, b) => b.lastSeen - a.lastSeen);

  const topCountries = Object.entries(countries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([code, count]) => ({ code, count }));

  return res.status(200).json({
    total: devices.length, active24h, active7d,
    platforms: { mobile, desktop, unknown },
    builds,
    currentBuild,
    outdatedCount,
    topCountries,
    devices,
    version: process.env.VPN_VERSION || "v0.2.1-X",
    updated: new Date().toISOString(),
  });
}

// API: пересчитать platform/client/build по UA для всех устройств
async function apiRecalculate(req, res) {
  const r = getRedis();
  const all = await r.hgetall("devices");
  let updated = 0;
  const pipeline = r.pipeline();

  let currentBuild = process.env.VPN_BUILD || "65";
  try {
    const { getSubscriptionText } = await import("./subscription.js");
    const sub = await getSubscriptionText(r);
    const parsedB = parseBuildFromSub(sub);
    if (parsedB && parsedB !== "unknown") currentBuild = parsedB;
  } catch {}

  for (const [id, raw] of Object.entries(all)) {
    let info;
    try { info = JSON.parse(raw); } catch { continue; }
    const ua = info.ua || "unknown";
    const platform = detectPlatform(ua);
    const client = parseClient(ua);
    const devBuild = normalizeBuild(info.build || "unknown");
    const needsBuildUpdate = devBuild === "unknown";
    const needsUpdate = info.platform !== platform
      || !info.client?.label
      || info.client.label !== client.label
      || info.client.name !== client.name
      || needsBuildUpdate;
    if (needsUpdate) {
      info.platform = platform;
      info.client = client;
      if (needsBuildUpdate) info.build = currentBuild;
      pipeline.hset("devices", id, JSON.stringify(info));
      updated++;
    }
  }

  if (updated) await pipeline.exec();
  return res.status(200).json({ ok: true, updated });
}

// API: удалить устройство
async function apiDeleteDevice(req, res) {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const r = getRedis();
  await r.hdel("devices", deviceId);
  return res.status(200).json({ ok: true });
}

// API: очистить неактивные или устаревшие устройства
async function apiPurge(req, res) {
  const type = req.query?.type;
  const days = parseInt(req.query?.days || "30", 10);
  const r = getRedis();
  const all = await r.hgetall("devices");
  const toRemove = [];

  if (type === "outdated") {
    let currentBuild = "unknown";
    try {
      const { getSubscriptionText } = await import("./subscription.js");
      currentBuild = parseBuildFromSub(await getSubscriptionText(r));
    } catch {}

    const cutoff7d = Date.now() - 7 * 86400000;
    for (const [id, raw] of Object.entries(all)) {
      let info;
      try { info = JSON.parse(raw); } catch { continue; }
      const build = normalizeBuild(info.build || "unknown");
      const isOutdated = currentBuild !== "unknown" && build !== "unknown" && build !== currentBuild;
      const isStaleUnknown = build === "unknown" && (info.lastSeen || 0) < cutoff7d;
      if (isOutdated || isStaleUnknown) {
        toRemove.push(id);
      }
    }
  } else {
    const cutoff = Date.now() - days * 86400000;
    for (const [id, raw] of Object.entries(all)) {
      let info;
      try { info = JSON.parse(raw); } catch { continue; }
      if ((info.lastSeen || 0) < cutoff) toRemove.push(id);
    }
  }

  if (toRemove.length) {
    const pipeline = r.pipeline();
    toRemove.forEach(id => pipeline.hdel("devices", id));
    await pipeline.exec();
  }
  return res.status(200).json({ removed: toRemove.length });
}

async function pushToGithub(path, content, ghToken, repo) {
  if (!ghToken) return { ok: false, error: "GITHUB_TOKEN не настроен" };
  try {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const getResp = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "PiskoVPN-Admin" },
    });
    let sha = undefined;
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
    }

    const putPayload = {
      message: `Update ${path} via admin panel`,
      content: Buffer.from(content, "utf8").toString("base64"),
    };
    if (sha) putPayload.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "User-Agent": "PiskoVPN-Admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(putPayload),
    });
    const putData = await putResp.json();
    return putResp.ok ? { ok: true, commit: putData.commit?.sha?.slice(0, 7) } : { ok: false, error: putData.message };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// API: получить текст подписки TXT и JSON
async function apiGetSub(req, res) {
  const r = getRedis();
  const { getSubscriptionText } = await import("./subscription.js");
  const txt = await getSubscriptionText(r).catch(() => "");

  let json = await r.get("sub_json_cache").catch(() => null);
  if (!json) {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    try {
      json = readFileSync(join(process.cwd(), "PiskoVPN.json"), "utf8");
    } catch {}
  }
  return res.status(200).json({ txt: txt || "", json: json || "", text: txt || "" });
}

// API: обновить текст подписки (TXT и JSON) — пушим в GitHub + сохраняем в Redis
async function apiUpdateSub(req, res) {
  const { txt, json, text } = req.body || {};
  const txtContent = txt !== undefined ? txt : text;
  const r = getRedis();
  const repo = process.env.GITHUB_REPO || "FivFiv133/piskovpn-api";
  const ghToken = process.env.GITHUB_TOKEN;

  let githubTxt = null;
  let githubJson = null;

  if (typeof txtContent === "string" && txtContent.trim()) {
    if (txtContent.length > 500000) return res.status(400).json({ error: "TXT too large (max 500KB)" });
    await r.set("sub_cache", txtContent, "EX", 86400).catch(() => {});
    githubTxt = await pushToGithub("PiskoVPN.txt", txtContent, ghToken, repo);
  }

  if (typeof json === "string" && json.trim()) {
    if (json.length > 1000000) return res.status(400).json({ error: "JSON too large (max 1MB)" });
    await r.set("sub_json_cache", json, "EX", 86400).catch(() => {});
    githubJson = await pushToGithub("PiskoVPN.json", json, ghToken, repo);
  }

  const ok = (!githubTxt || githubTxt.ok) && (!githubJson || githubJson.ok);
  return res.status(200).json({ ok, githubTxt, githubJson });
}

// API: проверка серверов из подписки
async function apiServers(req, res) {
  const r = getRedis();
  const { getSubscriptionText } = await import("./subscription.js");
  const text = await getSubscriptionText(r);
  const lines = text.split("\n").filter(l => l.startsWith("vless://") || l.startsWith("hysteria2://"));
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
      const proto = line.startsWith("hysteria2://") ? "hy2" : "vless";
      servers.push({ host, port: parseInt(port), name, proto });
    } catch { }
  }

  // Лимит чтобы не таймаутить на Vercel
  const limited = servers.slice(0, 20);

  const net = await import("net");
  const tls = await import("tls");

  function tcpPing(host, port, timeout = 4000) {
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

  function tlsPing(host, port, timeout = 4000) {
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
      const r = await tlsPing(s.host, s.port);
      if (r.ok) return { ...s, status: "online", ping: r.ping };
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
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
    if (action === "recalculate" && req.method === "POST") return await apiRecalculate(req, res);
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
<title>PiskoVPN — Вход в Control Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050508;
    --surface: rgba(18, 16, 28, 0.7);
    --border: rgba(139, 92, 246, 0.15);
    --border-focus: rgba(139, 92, 246, 0.45);
    --primary: #8b5cf6;
    --primary-glow: rgba(139, 92, 246, 0.35);
    --text: #f8fafc;
    --text-muted: #64748b;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    overflow: hidden;
    padding: 20px;
    position: relative;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: 
      radial-gradient(ellipse 60% 50% at 50% 15%, rgba(139, 92, 246, 0.12) 0%, transparent 70%),
      radial-gradient(ellipse 40% 40% at 85% 85%, rgba(14, 165, 233, 0.08) 0%, transparent 60%),
      radial-gradient(ellipse 35% 35% at 15% 75%, rgba(16, 185, 129, 0.06) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }
  .particles { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
  .particles span { position: absolute; width: 2px; height: 2px; background: #a78bfa; border-radius: 50%; animation: float linear infinite; opacity: 0; }
  @keyframes float {
    0% { transform: translateY(100vh) scale(0); opacity: 0; }
    15% { opacity: 0.7; }
    85% { opacity: 0.7; }
    100% { transform: translateY(-10vh) scale(1.2); opacity: 0; }
  }
  .login-box {
    position: relative;
    z-index: 1;
    background: var(--surface);
    backdrop-filter: blur(28px);
    -webkit-backdrop-filter: blur(28px);
    border: 1px solid var(--border);
    border-radius: 28px;
    padding: 44px 36px;
    width: 100%;
    max-width: 410px;
    text-align: center;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 50px rgba(139, 92, 246, 0.08);
    animation: fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
  .logo-wrap {
    width: 68px;
    height: 68px;
    margin: 0 auto 20px;
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.25), rgba(167, 139, 250, 0.15));
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(139, 92, 246, 0.35);
    box-shadow: 0 0 30px rgba(139, 92, 246, 0.25);
    color: #c4b5fd;
  }
  .logo-wrap svg { width: 34px; height: 34px; }
  h1 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 6px; letter-spacing: -0.03em; }
  h1 span { background: linear-gradient(135deg, #c4b5fd, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .sub { color: var(--text-muted); font-size: 13px; margin-bottom: 28px; font-weight: 500; }
  .input-wrap { position: relative; margin-bottom: 14px; }
  .input-wrap input {
    width: 100%;
    background: rgba(10, 8, 18, 0.65);
    border: 1px solid var(--border);
    color: #f1f5f9;
    padding: 13px 16px 13px 44px;
    border-radius: 14px;
    font-size: 14px;
    font-family: inherit;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .input-wrap input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
    background: rgba(14, 12, 24, 0.85);
  }
  .input-wrap input::placeholder { color: #475569; }
  .input-wrap .ico {
    position: absolute;
    left: 15px;
    top: 50%;
    transform: translateY(-50%);
    color: #64748b;
    transition: color 0.2s;
    display: flex;
    align-items: center;
  }
  .input-wrap input:focus ~ .ico { color: #a78bfa; }
  .ico svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  button[type=submit] {
    width: 100%;
    background: linear-gradient(135deg, #8b5cf6, #6d28d9);
    color: #fff;
    border: none;
    padding: 13px;
    border-radius: 14px;
    font-size: 14px;
    font-weight: 700;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    margin-top: 8px;
    box-shadow: 0 4px 18px rgba(139, 92, 246, 0.35);
  }
  button[type=submit]:hover {
    box-shadow: 0 6px 26px rgba(139, 92, 246, 0.5);
    transform: translateY(-1px);
  }
  button[type=submit]:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .error-msg { color: #f43f5e; font-size: 12px; margin-top: 14px; min-height: 18px; font-weight: 500; }
</style>
</head>
<body>
<div class="particles" id="pts"></div>
<div class="login-box">
  <div class="logo-wrap">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/></svg>
  </div>
  <h1><span>PiskoVPN</span> Control</h1>
  <div class="sub">Вход в панель управления инфраструктурой</div>
  <form id="loginForm">
    <div class="input-wrap">
      <input type="text" id="user" placeholder="Логин администратора" autocomplete="username" required>
      <span class="ico"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
    </div>
    <div class="input-wrap">
      <input type="password" id="pass" placeholder="Пароль" autocomplete="current-password" required>
      <span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
    </div>
    <button type="submit" id="loginBtn">Войти в систему</button>
  </form>
  <div class="error-msg" id="err"></div>
</div>
<script>
(function(){
  const c = document.getElementById('pts');
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.style.left = Math.random() * 100 + '%';
    s.style.animationDuration = (6 + Math.random() * 8) + 's';
    s.style.animationDelay = Math.random() * 5 + 's';
    s.style.width = s.style.height = (1 + Math.random() * 2) + 'px';
    c.appendChild(s);
  }
})();
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("loginBtn");
  const err = document.getElementById("err");
  btn.disabled = true; btn.textContent = "Проверка...";
  err.textContent = "";
  try {
    const r = await fetch("/stats?action=login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: document.getElementById("user").value, pass: document.getElementById("pass").value }),
    });
    const d = await r.json();
    if (d.ok) { window.location.href = "/stats"; }
    else { err.textContent = d.error || "Ошибка авторизации"; btn.disabled = false; btn.textContent = "Войти в систему"; }
  } catch(ex) { err.textContent = "Ошибка соединения с сервером"; btn.disabled = false; btn.textContent = "Войти в систему"; }
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
<title>PiskoVPN — Control Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050508;
    --surface: rgba(18, 16, 28, 0.55);
    --surface-hover: rgba(26, 23, 38, 0.75);
    --border: rgba(139, 92, 246, 0.12);
    --border-glow: rgba(139, 92, 246, 0.3);
    --primary: #8b5cf6;
    --primary-light: #a78bfa;
    --success: #10b981;
    --warning: #fbbf24;
    --danger: #f43f5e;
    --text: #f1f5f9;
    --text-muted: #64748b;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    position: relative;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: 
      radial-gradient(circle at 50% 0%, rgba(139, 92, 246, 0.1) 0%, transparent 60%),
      radial-gradient(circle at 90% 20%, rgba(14, 165, 233, 0.05) 0%, transparent 50%),
      radial-gradient(circle at 10% 80%, rgba(16, 185, 129, 0.04) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
  }
  .mono { font-family: 'JetBrains Mono', monospace; }
  .inline-svg { width: 14px; height: 14px; vertical-align: -2px; display: inline-block; }
  .metric-icon { width: 22px; height: 22px; }
  .metric-icon.purple { color: #a78bfa; }
  .metric-icon.green { color: #34d399; }
  .metric-icon.blue { color: #38bdf8; }
  .metric-icon.red { color: #f43f5e; }

  .header {
    position: relative;
    z-index: 10;
    background: rgba(14, 12, 22, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    padding: 16px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    gap: 12px;
  }
  .header-left { display: flex; align-items: center; gap: 12px; }
  .logo-icon {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.25), rgba(167, 139, 250, 0.15));
    border: 1px solid rgba(139, 92, 246, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 0 16px rgba(139, 92, 246, 0.2);
    color: #c4b5fd;
  }
  .header h1 { font-size: 20px; color: #fff; font-weight: 800; letter-spacing: -0.03em; display: flex; align-items: center; gap: 8px; }
  .header h1 span { background: linear-gradient(135deg, #c4b5fd, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .version-tag {
    background: rgba(139, 92, 246, 0.15);
    color: var(--primary-light);
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    border: 1px solid rgba(139, 92, 246, 0.25);
  }
  .header-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .health-pill {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    color: #34d399;
    padding: 6px 14px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .health-pill:hover { background: rgba(16, 185, 129, 0.18); border-color: #34d399; transform: translateY(-1px); }
  .btn-logout {
    background: rgba(244, 63, 94, 0.08);
    border: 1px solid rgba(244, 63, 94, 0.2);
    color: #fb7185;
    padding: 6px 14px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .btn-logout:hover { background: rgba(244, 63, 94, 0.18); border-color: #f43f5e; color: #fff; }

  .content { position: relative; z-index: 1; max-width: 1440px; margin: 0 auto; padding-bottom: 40px; }

  /* BENTO GRID */
  .bento-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    padding: 24px 32px 14px;
  }
  .bento-card {
    background: var(--surface);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    position: relative;
    overflow: hidden;
  }
  .bento-card:hover {
    background: var(--surface-hover);
    border-color: var(--border-glow);
    transform: translateY(-2px);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
  }
  .bento-card .top-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 8px;
  }
  .bento-card .num {
    font-size: 34px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.04em;
    font-family: 'Plus Jakarta Sans', sans-serif;
  }
  .bento-card.purple .num { color: #c4b5fd; }
  .bento-card.green .num { color: #34d399; }
  .bento-card.blue .num { color: #38bdf8; }
  .bento-card.red .num { color: #fb7185; }

  /* COUNTRIES BAR */
  .countries-bar {
    padding: 0 32px 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .countries-bar .title { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 4px; display: flex; align-items: center; gap: 6px; }
  .country-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 10px;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
  }
  .country-chip .code { color: #c4b5fd; font-weight: 700; }
  .country-chip .cnt { color: var(--text-muted); font-size: 11px; }

  /* TOOLBAR */
  .toolbar {
    padding: 0 32px 16px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .search-wrap { position: relative; flex: 1; min-width: 220px; }
  .search-wrap input {
    width: 100%;
    background: var(--surface);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    color: #f1f5f9;
    padding: 9px 14px 9px 38px;
    border-radius: 12px;
    font-size: 13px;
    font-family: inherit;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .search-wrap input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
  }
  .search-wrap svg {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    color: var(--text-muted);
    pointer-events: none;
  }
  select, .btn {
    background: var(--surface);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    color: #e2e8f0;
    padding: 9px 14px;
    border-radius: 12px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  select:focus { outline: none; border-color: var(--primary); }
  .btn:hover { background: var(--surface-hover); border-color: var(--border-glow); transform: translateY(-1px); }
  .btn.refresh { border-color: rgba(16, 185, 129, 0.25); color: #34d399; }
  .btn.refresh:hover { background: rgba(16, 185, 129, 0.15); border-color: #34d399; }
  .btn.danger { border-color: rgba(244, 63, 94, 0.25); color: #fb7185; }
  .btn.danger:hover { background: rgba(244, 63, 94, 0.15); border-color: #f43f5e; color: #fff; }

  /* TABLE */
  .table-wrap { padding: 0 32px 24px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    backdrop-filter: blur(16px);
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  th {
    background: rgba(15, 13, 24, 0.85);
    padding: 12px 16px;
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  th:hover { color: var(--primary-light); }
  th.sorted-asc::after { content: " ▲"; color: var(--primary); }
  th.sorted-desc::after { content: " ▼"; color: var(--primary); }
  td {
    padding: 10px 16px;
    border-top: 1px solid rgba(139, 92, 246, 0.06);
    font-size: 13px;
    white-space: nowrap;
  }
  tr:hover td { background: rgba(139, 92, 246, 0.04); }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge.mobile { background: rgba(139, 92, 246, 0.12); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.25); }
  .badge.desktop { background: rgba(14, 165, 233, 0.12); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.25); }
  .badge.unknown { background: rgba(251, 191, 36, 0.12); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.25); }
  .badge.client { background: rgba(99, 102, 241, 0.12); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.25); }
  .badge.outdated { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
  .badge.ip-shared { background: rgba(139, 92, 246, 0.15); color: #e2e8f0; font-size: 11px; padding: 2px 6px; border-radius: 6px; }

  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .status-dot.online { background: #34d399; box-shadow: 0 0 10px #34d399, 0 0 20px rgba(52, 211, 153, 0.4); animation: pulse 2s infinite; }
  .status-dot.recent { background: #fbbf24; box-shadow: 0 0 8px rgba(251, 191, 36, 0.4); }
  .status-dot.offline { background: #475569; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  .btn-del-row {
    background: none;
    border: 1px solid rgba(244, 63, 94, 0.25);
    color: #fb7185;
    padding: 4px 8px;
    font-size: 11px;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
  }
  .btn-del-row:hover { background: rgba(244, 63, 94, 0.2); border-color: #f43f5e; color: #fff; }

  /* SECTIONS */
  .section { padding: 0 32px 20px; }
  .section-inner {
    background: var(--surface);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 20px;
  }
  details summary {
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 12px;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 8px;
    color: #f1f5f9;
  }

  .footer {
    text-align: center;
    padding: 24px;
    color: #475569;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
  }

  @media(max-width:768px) {
    .bento-grid { grid-template-columns: repeat(2, 1fr); padding: 16px; }
    .toolbar, .table-wrap, .section, .countries-bar { padding: 0 16px 16px; }
    .header { padding: 14px 16px; }
  }
</style>
</head>
<body>

<svg style="display:none">
  <symbol id="i-diamond" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>
  </symbol>
  <symbol id="i-mobile" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="2" width="14" height="20" rx="3" ry="3"/><line x1="12" y1="18" x2="12.01" y2="18"/>
  </symbol>
  <symbol id="i-desktop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
  </symbol>
  <symbol id="i-question" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </symbol>
  <symbol id="i-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </symbol>
  <symbol id="i-file-text" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
  </symbol>
  <symbol id="i-file-json" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>
  </symbol>
  <symbol id="i-folder-upload" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 11v6"/><path d="m9 14 3-3 3 3"/>
  </symbol>
  <symbol id="i-activity" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
  </symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </symbol>
  <symbol id="i-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </symbol>
  <symbol id="i-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </symbol>
  <symbol id="i-server" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
  </symbol>
</svg>

<div class="header">
  <div class="header-left">
    <div class="logo-icon">
      <svg style="width:20px;height:20px"><use href="#i-diamond"/></svg>
    </div>
    <div>
      <h1><span>PiskoVPN</span> Control</h1>
    </div>
    <span class="version-tag" id="ver">v0.2.1-X</span>
  </div>
  <div class="header-right">
    <span style="color:var(--text-muted);font-size:12px;" class="mono" id="updated"></span>
    <a href="/health" class="health-pill">
      <span class="status-dot online" style="margin:0"></span> Health Diagnostic
    </a>
    <button class="btn-logout" onclick="location.href='/stats?action=logout'">
      <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Выйти
    </button>
  </div>
</div>

<div class="content">
  <!-- BENTO METRICS -->
  <div class="bento-grid" id="cards"></div>
  <div class="countries-bar" id="countriesBar" style="display:none"></div>

  <!-- TOOLBAR -->
  <div class="toolbar">
    <div class="search-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" id="search" placeholder="Поиск по IP, клиенту, User-Agent…">
    </div>
    <select id="filterPlatform">
      <option value="">Все платформы</option>
      <option value="mobile">📱 Mobile</option>
      <option value="desktop">💻 Desktop</option>
      <option value="unknown">❓ Unknown</option>
    </select>
    <select id="filterStatus">
      <option value="">Все статусы</option>
      <option value="online">🟢 Online (5 мин)</option>
      <option value="recent">🟡 Недавно (24ч)</option>
      <option value="offline">⚪ Offline</option>
      <option value="outdated">🔴 Устаревший build</option>
      <option value="sharedip">👥 Общий IP (2+)</option>
    </select>
    <button class="btn refresh" onclick="loadData()"><svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Обновить</button>
    <button class="btn" onclick="recalculatePlatforms()"><svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> Пересчитать</button>
    <button class="btn danger" onclick="purgeOutdated()"><svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Очистить старые</button>
  </div>

  <!-- DEVICES TABLE -->
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th data-col="status">Статус</th>
          <th data-col="ip">IP Адрес</th>
          <th data-col="geo">Геопозиция</th>
          <th data-col="platform">Платформа</th>
          <th data-col="client">Клиент</th>
          <th data-col="ua">User-Agent</th>
          <th data-col="lastSeen">Последний визит</th>
          <th data-col="build">Build</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <!-- SERVERS PING MONITOR -->
  <div class="section">
    <details>
      <summary style="color:#34d399">
        <svg style="width:18px;height:18px;color:#34d399"><use href="#i-server"/></svg>
        Мониторинг серверов (Ping Test)
      </summary>
      <div class="section-inner">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn refresh" onclick="loadServers()" id="pingBtn">
            <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Запустить Ping All
          </button>
          <span id="pingStatus" style="font-size:12px;font-weight:600;color:var(--text-muted)"></span>
        </div>
        <div id="serversBox" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px">
          <span style="color:var(--text-muted);font-size:13px">Нажмите «Запустить Ping All» для проверки доступности нод</span>
        </div>
      </div>
    </details>
  </div>

  <!-- ACTIVITY CHART -->
  <div class="section">
    <details>
      <summary style="color:#fbbf24">
        <svg style="width:18px;height:18px;color:#fbbf24"><use href="#i-activity"/></svg>
        График активности клиентов (14 дней)
      </summary>
      <div class="section-inner">
        <canvas id="chartCanvas" width="800" height="200" style="width:100%;height:200px"></canvas>
      </div>
    </details>
  </div>

  <!-- SUBSCRIPTION DUAL FILE MANAGER -->
  <div class="section">
    <details open>
      <summary style="color:#a78bfa">
        <svg style="width:18px;height:18px;color:#a78bfa"><use href="#i-file-text"/></svg>
        Редактор подписки и конфигураций (PiskoVPN.txt + PiskoVPN.json)
      </summary>
      <div class="section-inner">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:16px">
          <!-- TXT Panel -->
          <div style="background:rgba(12,10,20,0.6);border:1px solid rgba(139,92,246,0.15);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700;font-size:13px;color:#c4b5fd;display:flex;align-items:center;gap:6px">
                <svg style="width:16px;height:16px;color:#a78bfa"><use href="#i-file-text"/></svg> PiskoVPN.txt (Ссылки)
              </span>
              <label class="btn" style="padding:5px 12px;font-size:11px;cursor:pointer">
                <svg style="width:13px;height:13px"><use href="#i-folder-upload"/></svg> Выбрать .txt файл
                <input type="file" id="fileTxtInput" accept=".txt" style="display:none" onchange="handleFileSelect(event, 'subText', 'fileTxtStatus')">
              </label>
            </div>
            <span id="fileTxtStatus" style="font-size:11px;color:var(--text-muted)"></span>
            <textarea id="subText" style="width:100%;height:220px;background:rgba(6,5,10,0.7);border:1px solid rgba(139,92,246,0.12);color:#e2e8f0;padding:12px;border-radius:10px;font-size:12px;resize:vertical" class="mono" placeholder="Загрузка PiskoVPN.txt..."></textarea>
          </div>

          <!-- JSON Panel -->
          <div style="background:rgba(12,10,20,0.6);border:1px solid rgba(16,185,129,0.15);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
              <span style="font-weight:700;font-size:13px;color:#34d399;display:flex;align-items:center;gap:6px">
                <svg style="width:16px;height:16px;color:#34d399"><use href="#i-file-json"/></svg> PiskoVPN.json (Конфигурации)
              </span>
              <label class="btn" style="padding:5px 12px;font-size:11px;cursor:pointer">
                <svg style="width:13px;height:13px"><use href="#i-folder-upload"/></svg> Выбрать .json файл
                <input type="file" id="fileJsonInput" accept=".json" style="display:none" onchange="handleFileSelect(event, 'subJsonText', 'fileJsonStatus')">
              </label>
            </div>
            <span id="fileJsonStatus" style="font-size:11px;color:var(--text-muted)"></span>
            <textarea id="subJsonText" style="width:100%;height:220px;background:rgba(6,5,10,0.7);border:1px solid rgba(16,185,129,0.12);color:#e2e8f0;padding:12px;border-radius:10px;font-size:12px;resize:vertical" class="mono" placeholder="Загрузка PiskoVPN.json..."></textarea>
          </div>
        </div>

        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn refresh" id="saveSubBtn" onclick="saveAllSub()">
            <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Загрузить и обновить всё (TXT + JSON)
          </button>
          <button class="btn" onclick="loadSub()">
            <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Перезагрузить из базы
          </button>
          <span id="subStatus" style="font-size:13px;font-weight:600"></span>
        </div>
      </div>
    </details>
  </div>
</div>

<div class="footer">PiskoVPN Infrastructure Control · <span id="totalFooter">0</span> устройств зарегистрировано</div>

<script>
let allDevices = [];
let dashboardMeta = { currentBuild: "unknown", outdatedCount: 0, topCountries: [] };
let sortCol = "lastSeen", sortDir = "desc";

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function loadData() {
  try {
    const r = await fetch("/stats?action=data");
    if (r.status === 401 || r.redirected) { location.href = "/stats"; return; }
    const d = await r.json();
    allDevices = d.devices || [];
    dashboardMeta = {
      currentBuild: d.currentBuild || "unknown",
      outdatedCount: d.outdatedCount || 0,
      topCountries: d.topCountries || [],
    };
    document.getElementById("ver").textContent = d.version;
    document.getElementById("updated").textContent = "Обновлено: " + new Date(d.updated).toLocaleTimeString("ru");
    document.getElementById("totalFooter").textContent = d.total || 0;
    renderCards(d);
    renderCountries(d);
    renderTable();
  } catch(e) { console.error(e); }
}

function renderCountries(d) {
  const bar = document.getElementById("countriesBar");
  const list = d.topCountries || [];
  if (!list.length) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  bar.innerHTML = '<span class="title"><svg style="width:13px;height:13px;color:#a78bfa"><use href="#i-globe"/></svg> География клиентов:</span>' +
    list.map(c => '<span class="country-chip"><span class="code">' + esc(c.code) + '</span><span class="cnt">×' + c.count + '</span></span>').join("");
}

function renderCards(d) {
  let buildsHtml = "";
  if (d.builds) {
    const entries = Object.entries(d.builds).sort((a,b) => b[1] - a[1]);
    const current = d.currentBuild || "unknown";
    buildsHtml = entries.map(([b,c]) => {
      const stale = current !== "unknown" && b !== "unknown" && b !== current;
      return '<div style="display:flex;align-items:center;gap:6px;font-size:12px" class="mono"><span style="color:' + (stale ? '#fb7185' : '#c4b5fd') + ';font-weight:700">' + esc(b) + '</span><span style="color:#64748b">×' + c + '</span>' + (stale ? '<span class="badge outdated" style="font-size:10px;padding:1px 6px">old</span>' : '') + '</div>';
    }).join("");
  }

  const cardsHtml = [
    '<div class="bento-card purple"><div class="top-label"><span>Всего устройств</span><svg class="metric-icon purple"><use href="#i-users"/></svg></div><div class="num">' + (d.total || 0) + '</div><div style="font-size:12px;color:var(--text-muted);margin-top:6px">Уникальных HWID & IP</div></div>',
    '<div class="bento-card green"><div class="top-label"><span>Активных за 24ч</span><svg class="metric-icon green"><use href="#i-activity"/></svg></div><div class="num">' + (d.active24h || 0) + '</div><div style="font-size:12px;color:var(--text-muted);margin-top:6px">Суточная аудитория</div></div>',
    '<div class="bento-card blue"><div class="top-label"><span>Активных за 7 дней</span><svg class="metric-icon blue"><use href="#i-calendar"/></svg></div><div class="num">' + (d.active7d || 0) + '</div><div style="font-size:12px;color:var(--text-muted);margin-top:6px">Недельный охват</div></div>',
    (d.outdatedCount || 0) > 0 ? '<div class="bento-card red"><div class="top-label"><span>Устаревший build</span><svg class="metric-icon red"><use href="#i-alert"/></svg></div><div class="num">' + d.outdatedCount + '</div><div style="font-size:12px;color:#fb7185;margin-top:6px">Требуют обновления</div></div>' : '',
    '<div class="bento-card"><div class="top-label"><span>Платформы</span><svg class="metric-icon purple"><use href="#i-desktop"/></svg></div><div style="display:flex;gap:12px;align-items:center;margin-top:4px"><span style="color:#c4b5fd;font-weight:700;font-size:15px;display:flex;align-items:center;gap:4px"><svg class="inline-svg"><use href="#i-mobile"/></svg> ' + (d.platforms?.mobile || 0) + '</span><span style="color:#38bdf8;font-weight:700;font-size:15px;display:flex;align-items:center;gap:4px"><svg class="inline-svg"><use href="#i-desktop"/></svg> ' + (d.platforms?.desktop || 0) + '</span></div><div style="font-size:11px;color:var(--text-muted);margin-top:8px">Mobile / Desktop</div></div>',
    buildsHtml ? '<div class="bento-card"><div class="top-label"><span>Билды (Актуальный: ' + esc(d.currentBuild || '?') + ')</span><svg class="metric-icon blue"><use href="#i-diamond"/></svg></div><div style="display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px">' + buildsHtml + '</div></div>' : ''
  ].filter(Boolean).join("");

  document.getElementById("cards").innerHTML = cardsHtml;
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
  if (p === "mobile") return '<span class="badge mobile"><svg class="inline-svg"><use href="#i-mobile"/></svg> Mobile</span>';
  if (p === "desktop") return '<span class="badge desktop"><svg class="inline-svg"><use href="#i-desktop"/></svg> Desktop</span>';
  return '<span class="badge unknown"><svg class="inline-svg"><use href="#i-question"/></svg> Unknown</span>';
}

function clientBadge(d) {
  const label = d.client?.label || "Unknown";
  return '<span class="badge client" title="' + esc(d.ua) + '">' + esc(label) + '</span>';
}

function renderTable() {
  const search = document.getElementById("search").value.toLowerCase();
  const fp = document.getElementById("filterPlatform").value;
  const fs = document.getElementById("filterStatus").value;

  let filtered = allDevices.filter(d => {
    const clientLabel = d.client?.label || "";
    if (search && !((d.ip + clientLabel + d.ua + d.platform).toLowerCase().includes(search))) return false;
    if (fp && d.platform !== fp) return false;
    if (fs === "outdated" && !d.outdated) return false;
    if (fs === "sharedip" && (d.ipCount || 1) < 2) return false;
    if (fs && fs !== "outdated" && fs !== "sharedip" && getStatus(d.lastSeen) !== fs) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let va, vb;
    if (sortCol === "client") {
      va = (a.client?.label || "").toLowerCase();
      vb = (b.client?.label || "").toLowerCase();
    } else if (sortCol === "status") {
      va = getStatus(a.lastSeen);
      vb = getStatus(b.lastSeen);
    } else if (sortCol === "geo") {
      va = (a.geo?.country || "").toLowerCase();
      vb = (b.geo?.country || "").toLowerCase();
    } else {
      va = a[sortCol];
      vb = b[sortCol];
      if (typeof va === "string") { va = va.toLowerCase(); vb = (vb || "").toLowerCase(); }
    }
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:36px;color:var(--text-muted)">Нет активных устройств по заданным фильтрам</td></tr>';
  } else {
    tbody.innerHTML = filtered.map(d => {
      const st = getStatus(d.lastSeen);
      const stLabel = st === "online" ? "Online" : st === "recent" ? "Недавно" : "Offline";
      const uaShort = d.ua.length > 42 ? d.ua.substring(0,42) + "…" : d.ua;
      const idEnc = btoa(d.id);

      return '<tr id="row-' + idEnc + '">' +
        '<td><span class="status-dot ' + st + '"></span>' + stLabel + '</td>' +
        '<td class="mono" style="font-size:12px;font-weight:600">' + esc(d.ip) + (d.ipCount > 1 ? '<span class="badge ip-shared">×' + d.ipCount + '</span>' : '') + '</td>' +
        '<td>' + (d.geo?.country && d.geo.country !== "??" ? '<b>' + esc(d.geo.country) + '</b> ' + esc(d.geo.city || "") : '<span style="color:#64748b">??</span>') + '</td>' +
        '<td>' + platformBadge(d.platform) + '</td>' +
        '<td>' + clientBadge(d) + '</td>' +
        '<td style="color:#94a3b8;font-size:12px" title="' + esc(d.ua) + '">' + esc(uaShort) + '</td>' +
        '<td class="mono" style="font-size:12px" title="' + esc(d.lastSeenISO) + '">' + timeAgo(d.lastSeen) + '</td>' +
        '<td><span class="badge ' + (d.outdated ? 'outdated' : 'client') + ' mono">' + esc(d.build) + '</span></td>' +
        '<td><button class="btn-del-row" data-id="' + idEnc + '" onclick="deleteDevice(this.dataset.id)">Удалить</button></td>' +
        '</tr>';
    }).join("");
  }
}

document.querySelectorAll("th[data-col]").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "desc"; }
    renderTable();
  });
});

document.getElementById("search").addEventListener("input", renderTable);
document.getElementById("filterPlatform").addEventListener("change", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

async function recalculatePlatforms() {
  const r = await fetch("/stats?action=recalculate", { method: "POST" });
  const d = await r.json();
  alert("Пересчитано устройств: " + (d.updated || 0));
  loadData();
}

async function purgeOutdated() {
  if (!confirm("Удалить устройства с устаревшим билдом (неактивные более 7 дней)?")) return;
  const r = await fetch("/stats?action=purge&type=outdated");
  const d = await r.json();
  alert("Удалено устройств: " + (d.removed || 0));
  loadData();
}

async function deleteDevice(idEnc) {
  const deviceId = atob(idEnc);
  if (!confirm("Удалить запись устройства?")) return;
  try {
    const r = await fetch("/stats?action=delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    const d = await r.json();
    if (d.ok) {
      const row = document.getElementById("row-" + idEnc);
      if (row) { row.style.transition = "opacity 0.25s"; row.style.opacity = "0"; setTimeout(() => loadData(), 250); }
    } else { alert("Ошибка: " + (d.error || "unknown")); }
  } catch(e) { alert("Ошибка: " + e.message); }
}

function handleFileSelect(event, targetTextareaId, statusId) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById(targetTextareaId).value = e.target.result;
    const st = document.getElementById(statusId);
    if (st) {
      st.textContent = "✓ Выбран файл: " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
      st.style.color = "#34d399";
    }
  };
  reader.readAsText(file);
}

async function loadSub() {
  const st = document.getElementById("subStatus");
  try {
    const r = await fetch("/stats?action=getSub");
    const d = await r.json();
    if (d.txt !== undefined) document.getElementById("subText").value = d.txt;
    else if (d.text !== undefined) document.getElementById("subText").value = d.text;
    if (d.json !== undefined) document.getElementById("subJsonText").value = d.json;
  } catch(e) {
    if (st) { st.textContent = "Ошибка загрузки: " + e.message; st.style.color = "#f87171"; }
  }
}

async function saveAllSub() {
  const btn = document.getElementById("saveSubBtn");
  const st = document.getElementById("subStatus");
  btn.disabled = true;
  st.textContent = "Загрузка и сохранение файлов...";
  st.style.color = "#fbbf24";

  const txt = document.getElementById("subText").value;
  const json = document.getElementById("subJsonText").value;

  try {
    const r = await fetch("/stats?action=updateSub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txt, json }),
    });
    const d = await r.json();
    if (d.ok) {
      let msg = "✓ Сохранено в Redis";
      if (d.githubTxt || d.githubJson) {
        const parts = [];
        if (d.githubTxt) parts.push("TXT: " + (d.githubTxt.ok ? "✓ " + d.githubTxt.commit : "✕ " + d.githubTxt.error));
        if (d.githubJson) parts.push("JSON: " + (d.githubJson.ok ? "✓ " + d.githubJson.commit : "✕ " + d.githubJson.error));
        msg += " + GitHub (" + parts.join(", ") + ")";
      }
      st.textContent = msg;
      st.style.color = "#34d399";
    } else {
      st.textContent = "Ошибка сохранения: " + (d.error || "Неизвестная ошибка");
      st.style.color = "#f87171";
    }
  } catch(e) {
    st.textContent = "Ошибка: " + e.message;
    st.style.color = "#f87171";
  }
  btn.disabled = false;
  setTimeout(() => { if (st) st.textContent = ""; }, 8000);
}

async function loadServers() {
  const box = document.getElementById("serversBox");
  const btn = document.getElementById("pingBtn");
  const st = document.getElementById("pingStatus");
  btn.disabled = true;
  st.textContent = "Проверка пинга...";
  st.style.color = "#fbbf24";
  box.innerHTML = '<span style="color:var(--text-muted);font-size:13px">Опрашиваем ноды...</span>';
  try {
    const r = await fetch("/stats?action=servers");
    const d = await r.json();
    if (!d.servers?.length) { box.innerHTML = '<span style="color:var(--text-muted)">Нет доступных серверов</span>'; st.textContent = ""; btn.disabled = false; return; }
    const online = d.servers.filter(s => s.status === "online").length;
    st.textContent = online + "/" + d.servers.length + " онлайн";
    st.style.color = online === d.servers.length ? "#34d399" : online > 0 ? "#fbbf24" : "#f87171";
    d.servers.sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return a.ping - b.ping;
    });
    box.innerHTML = d.servers.map(s => {
      const color = s.status === "online" ? "#34d399" : "#f87171";
      const bg = s.status === "online" ? "rgba(16,185,129,0.08)" : "rgba(244,63,94,0.08)";
      const border = s.status === "online" ? "rgba(16,185,129,0.25)" : "rgba(244,63,94,0.25)";
      const pingText = s.status === "online" ? s.ping + "ms" : "timeout";
      const pingColor = s.status !== "online" ? "#f87171" : s.ping < 180 ? "#34d399" : s.ping < 450 ? "#fbbf24" : "#f87171";
      return '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:10px 14px;font-size:12px;display:flex;align-items:center;gap:10px;min-width:210px">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';flex-shrink:0' + (s.status === 'online' ? ';box-shadow:0 0 8px ' + color : '') + '"></span>' +
        '<span style="color:#e2e8f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600" title="' + esc(s.host) + '">' + esc(s.name) + '</span>' +
        '<span style="color:' + pingColor + ';font-weight:700;font-size:11px" class="mono">' + pingText + '</span>' +
      '</div>';
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

    ctx.strokeStyle = "rgba(139,92,246,0.12)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + gH - (gH * i / 4);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#64748b"; ctx.font = "11px monospace"; ctx.textAlign = "right";
      ctx.fillText(Math.round(max * i / 4), pad.l - 8, y + 4);
    }

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
    grad.addColorStop(0, "rgba(139,92,246,0.25)");
    grad.addColorStop(1, "rgba(139,92,246,0.0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    d.days.forEach((p, i) => {
      const x = pad.l + i * step;
      const y = pad.t + gH - (p.count / max) * gH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#8b5cf6";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    d.days.forEach((p, i) => {
      const x = pad.l + i * step;
      const y = pad.t + gH - (p.count / max) * gH;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#a78bfa"; ctx.fill();
      if (i % 2 === 0 || i === d.days.length - 1) {
        ctx.fillStyle = "#64748b"; ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.fillText(p.date.slice(5), x, H - pad.b + 18);
      }
    });
  } catch(e) { console.error(e); }
}

loadData();
loadSub();
loadChart();
setInterval(loadData, 10000);
</script>
</body>
</html>`;
}

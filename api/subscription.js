import Redis from "ioredis";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { detectPlatform, parseClient, normalizeBuild, extractDeviceId, parseBuildFromSub } from "./device-utils.js";

const RAW_URL = process.env.RAW_SUB_URL || "https://raw.githubusercontent.com/FivFiv133/piskovpn-api/refs/heads/main/PiskoVPN.txt";
const REDIS_GET_MS = 400;
const REDIS_WRITE_MS = 700;
const GITHUB_FETCH_MS = 2500;

const __dir = dirname(fileURLToPath(import.meta.url));
const BUNDLE_TXT_PATHS = [join(__dir, "..", "PiskoVPN.txt"), join(process.cwd(), "PiskoVPN.txt")];
const BUNDLE_JSON_PATHS = [join(__dir, "..", "PiskoVPN.json"), join(process.cwd(), "PiskoVPN.json")];

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 2,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 150, 600);
      },
    });
    redis.on("error", (err) => console.error("[REDIS] Connection error:", err.message));
  }
  return redis;
}

function readBundleText(paths) {
  for (const p of paths) {
    try { return readFileSync(p, "utf-8"); } catch {}
  }
  return null;
}

async function redisGet(key, ms = REDIS_GET_MS) {
  try {
    const r = getRedis();
    return await Promise.race([
      r.get(key),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch {
    return null;
  }
}

async function ensureRedisReady(r, ms = REDIS_WRITE_MS) {
  if (r.status === "ready") return true;
  try {
    await Promise.race([
      r.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("redis connect timeout")), ms)),
    ]);
    return r.status === "ready";
  } catch (e) {
    console.error("[SUB] Redis connect:", e.message);
    return false;
  }
}

async function resolveSubscriptionBody() {
  const bundled = readBundleText(BUNDLE_TXT_PATHS);

  const cached = await redisGet("sub_cache");
  if (cached) {
    if (bundled) {
      const bBuild = parseInt(parseBuildFromSub(bundled) || "0", 10);
      const cBuild = parseInt(parseBuildFromSub(cached) || "0", 10);
      if (bBuild > cBuild) return bundled;
    }
    return cached;
  }
  if (bundled) return bundled;

  try {
    const resp = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(GITHUB_FETCH_MS) });
    if (resp.ok) return await resp.text();
  } catch (e) {
    console.error("[SUB] Failed to fetch raw:", e.message);
  }

  return bundled;
}

async function resolveJsonArrayBody() {
  const bundled = readBundleText(BUNDLE_JSON_PATHS);
  const cached = await redisGet("sub_json_cache");
  if (cached) {
    if (bundled) {
      const bBuild = parseInt(parseBuildFromSub(bundled) || "0", 10);
      const cBuild = parseInt(parseBuildFromSub(cached) || "0", 10);
      if (bBuild > cBuild) return bundled;
    }
    return cached;
  }
  return bundled;
}

// Фетчим подписку — для админки (может подождать дольше)
export async function getSubscriptionText(r) {
  const bundled = readBundleText(BUNDLE_TXT_PATHS);
  const cached = await r.get("sub_cache").catch(() => null);
  if (cached) {
    if (bundled) {
      const bBuild = parseInt(parseBuildFromSub(bundled) || "0", 10);
      const cBuild = parseInt(parseBuildFromSub(cached) || "0", 10);
      if (bBuild > cBuild) return bundled;
    }
    return cached;
  }

  try {
    const resp = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const text = await resp.text();
      await r.set("sub_cache", text, "EX", 60).catch(() => {});
      return text;
    }
  } catch (e) {
    console.error("[SUB] Failed to fetch raw:", e.message);
  }

  if (bundled) return bundled;

  throw new Error("Subscription text not found");
}

function safeHeader(val) {
  if (!val) return null;
  if (/[^\x20-\x7E]/.test(val)) {
    return "base64:" + Buffer.from(val, "utf8").toString("base64");
  }
  return val;
}

async function recordVisit(req, subText) {
  try {
    const r = getRedis();
    const ip = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket?.remoteAddress || "").split(",")[0]?.trim() || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    const deviceId = extractDeviceId(req, ip, ua);

    const platform = detectPlatform(ua);
    const client = parseClient(ua);
    const bodyText = typeof subText === "string" ? subText : "";
    const build = parseBuildFromSub(bodyText);

    let geo = { country: "??", city: "" };
    if (ip !== "unknown") {
      const geoCache = await r.get(`geo:${ip}`).catch(() => null);
      if (geoCache) {
        try { geo = JSON.parse(geoCache); } catch {}
      }
    }

    const payload = JSON.stringify({
      ip,
      ua,
      platform,
      client,
      build,
      geo,
      lastSeen: Date.now()
    });
    const today = new Date().toISOString().slice(0, 10);

    // Прямая атомарная запись в Redis
    await Promise.all([
      r.hset("devices", deviceId, payload),
      r.pfadd(`daily:${today}`, deviceId),
      r.expire(`daily:${today}`, 2592000),
    ]);

    // Фоновое получение геопозиции, если еще нет
    if (ip !== "unknown" && geo.country === "??") {
      fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,city`, { signal: AbortSignal.timeout(2000) })
        .then(res => res.json())
        .then(data => {
          if (data.status === "success") {
            r.set(`geo:${ip}`, JSON.stringify({ country: data.countryCode || "??", city: data.city || "" }), "EX", 86400).catch(() => {});
          }
        }).catch(() => {});
    }
  } catch (err) {
    console.error("[SUB] Record visit error:", err.message);
  }
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const format = (url.searchParams.get("format") || "").toLowerCase();

    const subText = await resolveSubscriptionBody();
    if (!subText) return res.status(500).send("Subscription not found");

    // Записываем визит устройства в реальном времени
    await recordVisit(req, subText);

    let body;
    let isJson = false;

    if (format === "json") {
      // JSON-массив конфигураций Happ (Content-Type: application/json)
      body = (await resolveJsonArrayBody()) || subText;
      isJson = true;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    } else if (format === "b64" || format === "base64") {
      // Base64 VLESS-ссылки
      const linkLines = subText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      body = Buffer.from(linkLines.join("\n"), "utf8").toString("base64");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    } else {
      // По умолчанию: прямые текстовые VLESS-ссылки (Content-Type: text/plain)
      body = subText;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }

    // Извлекаем аннотации и заголовки из subText с безопасным кодированием для HTTP
    const profileTitleMatch = subText.match(/^#\s*profile-title:\s*(.+)$/m);
    const profileUpdateMatch = subText.match(/^#\s*profile-update-interval:\s*(.+)$/m);
    const profileWebMatch = subText.match(/^#\s*profile-web-page:\s*(.+)$/m);
    const supportUrlMatch = subText.match(/^#\s*support-url:\s*(.+)$/m);
    const announceMatch = subText.match(/^#\s*announce:\s*(.+)$/m);

    // Profile Title
    const titleVal = profileTitleMatch ? profileTitleMatch[1].trim() : "💎 PiskoVPN 💎";
    const safeTitle = safeHeader(titleVal);
    if (safeTitle) res.setHeader("profile-title", safeTitle);

    // Profile Update Interval
    const updateVal = profileUpdateMatch ? profileUpdateMatch[1].trim() : "1";
    res.setHeader("profile-update-interval", updateVal);

    // Announce (Version / Banner line in Happ)
    const announceVal = announceMatch ? announceMatch[1].trim() : "Версия: v0.2.1-X | build-67";
    const safeAnnounce = safeHeader(announceVal);
    if (safeAnnounce) res.setHeader("announce", safeAnnounce);

    // Support URL (Telegram bot / Support link in Happ)
    const supportVal = supportUrlMatch ? supportUrlMatch[1].trim() : "https://t.me/piskovpn_bot";
    res.setHeader("support-url", supportVal);

    if (profileWebMatch) {
      const safe = safeHeader(profileWebMatch[1].trim());
      if (safe) res.setHeader("profile-web-page", safe);
    }

    res.setHeader("Content-Disposition", isJson ? 'attachment; filename="PiskoVPN.json"' : 'attachment; filename="PiskoVPN"');
    // Отключаем кеширование на прокси/edge, чтобы каждый визит сразу обновлялся в базе
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
}






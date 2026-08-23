import Redis from "ioredis";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { detectPlatform, parseClient, normalizeBuild } from "./device-utils.js";

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
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 2) return null;
        return Math.min(times * 200, 1000);
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
  if (cached) return cached;
  if (bundled) return bundled;

  try {
    const resp = await fetch(RAW_URL, { signal: AbortSignal.timeout(GITHUB_FETCH_MS) });
    if (resp.ok) return await resp.text();
  } catch (e) {
    console.error("[SUB] Failed to fetch raw:", e.message);
  }

  return bundled;
}

function resolveJsonBody() {
  const raw = readBundleText(BUNDLE_JSON_PATHS);
  if (!raw) return null;
  try {
    const configs = JSON.parse(raw);
    if (Array.isArray(configs)) {
      return configs.map((c) => JSON.stringify(c)).join("\n");
    }
  } catch {}
  return raw;
}

// Фетчим подписку — для админки (может подождать дольше)
export async function getSubscriptionText(r) {
  const cached = await r.get("sub_cache").catch(() => null);
  if (cached) return cached;

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

  const bundled = readBundleText(BUNDLE_TXT_PATHS);
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
  const r = getRedis();
  if (!(await ensureRedisReady(r))) return;

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const queryHwid = url.searchParams.get("hwid") || url.searchParams.get("id");
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const hwid = req.headers["x-hwid"] || req.headers["hwid"] || queryHwid || null;

  let deviceId = hwid;
  if (!deviceId) {
    const ipPrefix = ip !== "unknown" ? ip.split(".").slice(0, 2).join(".") : null;
    const now = Date.now();
    try {
      const all = await r.hgetall("devices");
      let matchedKey = null;
      for (const [id, raw] of Object.entries(all)) {
        let info;
        try { info = JSON.parse(raw); } catch { continue; }
        if (info.ua === ua && (now - (info.lastSeen || 0)) < 86400000) {
          if (info.ip === ip) { matchedKey = id; break; }
          if (ipPrefix && info.ip && info.ip.startsWith(ipPrefix + ".")) { matchedKey = id; }
        }
      }
      if (matchedKey) deviceId = matchedKey;
    } catch {}
  }
  if (!deviceId) deviceId = `${ip}_${ua}`;

  const platform = detectPlatform(ua);
  const client = parseClient(ua);
  const bodyText = typeof subText === "string" ? subText : "";
  const buildMatch = bodyText.match(/^#\s*(build-\S+)/im) || bodyText.match(/^#\s*build[:\-]\s*(.+)/im);
  const build = buildMatch ? normalizeBuild(buildMatch[1].trim()) : "unknown";

  let geo = { country: "??", city: "" };
  if (ip !== "unknown") {
    const geoCache = await r.get(`geo:${ip}`).catch(() => null);
    if (geoCache) try { geo = JSON.parse(geoCache); } catch {}
  }

  const payload = JSON.stringify({ ip, ua, platform, client, build, geo, lastSeen: Date.now() });
  const today = new Date().toISOString().slice(0, 10);

  await Promise.all([
    r.hset("devices", deviceId, payload),
    r.pfadd(`daily:${today}`, deviceId),
    r.expire(`daily:${today}`, 2592000),
    bodyText ? r.set("sub_cache", bodyText, "EX", 60) : Promise.resolve(),
  ]);

  if (ip !== "unknown" && geo.country === "??") {
    fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,city`, { headers: { "User-Agent": "PiskoVPN-Geo/1.0" }, signal: AbortSignal.timeout(2000) })
      .then((resp) => resp.json())
      .then((data) => {
        if (data.status === "success") {
          r.set(`geo:${ip}`, JSON.stringify({ country: data.countryCode || "??", city: data.city || "" }), "EX", 86400).catch(() => {});
        }
      }).catch(() => {});
  }
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const format = (url.searchParams.get("format") || "").toLowerCase();

    const subText = await resolveSubscriptionBody();
    if (!subText) return res.status(500).send("Subscription not found");

    // Извлекаем только ссылки (vless://, hysteria2://, hy2://)
    const linkLines = subText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    let body;
    if (format === "raw" || format === "txt" || format === "text") {
      // Исходный текст со всеми комментариями и ссылками
      body = subText;
    } else if (format === "links") {
      // Только чистые ссылки без комментариев
      body = linkLines.join("\n");
    } else {
      // Общепринятый мировой стандарт подписок (Base64-поток ссылок)
      body = Buffer.from(linkLines.join("\n"), "utf8").toString("base64");
    }

    // Статистика до ответа — на Vercel фон после res.send() не успевает выполниться
    try {
      await Promise.race([
        recordVisit(req, subText),
        new Promise((resolve) => setTimeout(resolve, REDIS_WRITE_MS)),
      ]);
    } catch (e) {
      console.error("[SUB] Analytics error:", e.message);
    }

    // Извлекаем аннотации и заголовки из subText с безопасным кодированием для HTTP
    const profileTitleMatch = subText.match(/^#\s*profile-title:\s*(.+)$/m);
    const profileUpdateMatch = subText.match(/^#\s*profile-update-interval:\s*(.+)$/m);
    const profileWebMatch = subText.match(/^#\s*profile-web-page:\s*(.+)$/m);
    const supportUrlMatch = subText.match(/^#\s*support-url:\s*(.+)$/m);
    const announceMatch = subText.match(/^#\s*announce:\s*(.+)$/m);

    if (profileTitleMatch) {
      const safe = safeHeader(profileTitleMatch[1].trim());
      if (safe) res.setHeader("profile-title", safe);
    }
    if (profileUpdateMatch) {
      const safe = safeHeader(profileUpdateMatch[1].trim());
      if (safe) res.setHeader("profile-update-interval", safe);
    }
    if (profileWebMatch) {
      const safe = safeHeader(profileWebMatch[1].trim());
      if (safe) res.setHeader("profile-web-page", safe);
    }
    if (supportUrlMatch) {
      const safe = safeHeader(supportUrlMatch[1].trim());
      if (safe) res.setHeader("support-url", safe);
    }
    if (announceMatch) {
      const safe = safeHeader(announceMatch[1].trim());
      if (safe) res.setHeader("announce", safe);
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.setHeader("CDN-Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.setHeader("Pragma", "no-cache");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
}





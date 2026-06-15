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
const BUNDLE_PATHS = [join(__dir, "..", "PiskoVPN.txt"), join(process.cwd(), "PiskoVPN.txt")];

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

function readBundleText() {
  for (const p of BUNDLE_PATHS) {
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
  const bundled = readBundleText();

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

  const bundled = readBundleText();
  if (bundled) return bundled;

  throw new Error("Subscription text not found");
}

async function recordVisit(req, body) {
  const r = getRedis();
  if (!(await ensureRedisReady(r))) return;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
  const ua = req.headers["user-agent"] || "unknown";
  const hwid = req.headers["x-hwid"] || req.headers["hwid"] || null;
  const deviceId = hwid || `${ip}_${ua}`;
  const platform = detectPlatform(ua);
  const client = parseClient(ua);
  const buildMatch = body.match(/^#\s*(build-\S+)/im) || body.match(/^#\s*build[:\-]\s*(.+)/im);
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
    r.set("sub_cache", body, "EX", 60),
  ]);

  if (ip !== "unknown" && geo.country === "??") {
    fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,city`, { signal: AbortSignal.timeout(2000) })
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
    const body = await resolveSubscriptionBody();
    if (!body) return res.status(500).send("Subscription not found");

    // Статистика до ответа — на Vercel фон после res.send() не успевает выполниться
    try {
      await Promise.race([
        recordVisit(req, body),
        new Promise((resolve) => setTimeout(resolve, REDIS_WRITE_MS)),
      ]);
    } catch (e) {
      console.error("[SUB] Analytics error:", e.message);
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.setHeader("CDN-Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("profile-update-interval", "5");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
}

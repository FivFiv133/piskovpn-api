import Redis from "ioredis";

const RAW_URL = process.env.RAW_SUB_URL || "https://raw.githubusercontent.com/FivFiv133/piskovpn-api/refs/heads/main/PiskoVPN.txt";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
    redis.on("error", (err) => console.error("[REDIS] Connection error:", err.message));
  }
  return redis;
}

function detectPlatform(ua) {
  const lower = ua.toLowerCase();
  if (lower.includes("android") || lower.includes("iphone") || lower.includes("ipad") || lower.includes("mobile")) return "mobile";
  if (lower.includes("windows") || lower.includes("macintosh") || lower.includes("linux") || lower.includes("desktop")) return "desktop";
  return "unknown";
}

async function fetchRaw() {
  try {
    const resp = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!resp.ok) return null;
    const text = await resp.text();
    const lastMod = resp.headers.get("last-modified");
    const ts = lastMod ? new Date(lastMod).getTime() : Date.now();
    return { text, ts };
  } catch (e) {
    console.error("[SUB] Failed to fetch raw:", e.message);
    return null;
  }
}

// Получить самый свежий текст подписки: сравниваем Redis (панель) vs GitHub raw
export async function getLatestSubscription(r) {
  // Данные из Redis (сохранённые через админку)
  const [redisText, redisTs] = await Promise.all([
    r.get("subscription_text"),
    r.get("subscription_updated"),
  ]);
  const redisTime = redisTs ? parseInt(redisTs, 10) : 0;

  // Проверяем кеш raw (чтобы не фетчить каждый запрос)
  const rawCache = await r.get("raw_cache_text");
  const rawCacheTs = await r.get("raw_cache_ts");
  const rawCacheTime = rawCacheTs ? parseInt(rawCacheTs, 10) : 0;
  const cacheAge = Date.now() - rawCacheTime;

  let rawText = null;
  let rawTime = 0;

  // Обновляем raw-кеш каждые 60 секунд
  if (rawCache && cacheAge < 60000) {
    rawText = rawCache;
    rawTime = rawCacheTime;
  } else {
    const raw = await fetchRaw();
    if (raw) {
      rawText = raw.text;
      rawTime = raw.ts;
      // Кешируем
      await r.set("raw_cache_text", raw.text);
      await r.set("raw_cache_ts", String(raw.ts));
    }
  }

  // Сравниваем: кто свежее
  if (redisText && redisTime >= rawTime) {
    return { text: redisText, source: "panel", ts: redisTime };
  }
  if (rawText) {
    return { text: rawText, source: "github", ts: rawTime };
  }
  if (redisText) {
    return { text: redisText, source: "panel", ts: redisTime };
  }

  // Fallback — файл из бандла
  try {
    const { readFileSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    for (const p of [join(__dirname, "..", "PiskoVPN.txt"), join(process.cwd(), "PiskoVPN.txt")]) {
      try { return { text: readFileSync(p, "utf-8"), source: "file", ts: 0 }; } catch {}
    }
  } catch {}

  throw new Error("Subscription text not found");
}

export default async function handler(req, res) {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    const hwid = req.headers["x-hwid"] || req.headers["hwid"] || null;
    const deviceId = hwid || `${ip}_${ua}`;
    const platform = detectPlatform(ua);

    const r = getRedis();
    await r.hset("devices", deviceId, JSON.stringify({ ip, ua, platform, lastSeen: Date.now() }));
    const deviceCount = await r.hlen("devices");

    const { text: body } = await getLatestSubscription(r);

    console.log(`[SUB] ${new Date().toISOString()} | ${platform} | IP: ${ip} | Total: ${deviceCount}`);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("profile-update-interval", "5");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    res.status(500).send("Internal server error");
  }
}

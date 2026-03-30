import Redis from "ioredis";

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
  if (lower.includes("android") || lower.includes("iphone") || lower.includes("ipad") || lower.includes("mobile")) {
    return "mobile";
  }
  if (lower.includes("windows") || lower.includes("macintosh") || lower.includes("linux") || lower.includes("desktop")) {
    return "desktop";
  }
  return "unknown";
}

async function getSubscriptionText(r) {
  // 1. Пробуем из Redis (обновляется мгновенно)
  const cached = await r.get("subscription_text");
  if (cached) return cached;

  // 2. Фетчим из GitHub raw (всегда актуальная версия)
  const rawUrl = process.env.RAW_SUB_URL || "https://raw.githubusercontent.com/FivFiv133/piskovpn-api/refs/heads/main/PiskoVPN.txt";
  if (rawUrl) {
    try {
      const resp = await fetch(rawUrl, {
        headers: { "Cache-Control": "no-cache" },
      });
      if (resp.ok) {
        const text = await resp.text();
        // Кешируем в Redis на 5 минут
        await r.set("subscription_text", text, "EX", 300);
        return text;
      }
    } catch (e) {
      console.error("[SUB] Failed to fetch from RAW_SUB_URL:", e.message);
    }
  }

  // 3. Fallback — файл из бандла (обновляется только при деплое)
  try {
    const { readFileSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dirname, "..", "PiskoVPN.txt"),
      join(__dirname, "..", "..", "PiskoVPN.txt"),
      join(process.cwd(), "PiskoVPN.txt"),
    ];
    for (const p of candidates) {
      try {
        const text = readFileSync(p, "utf-8");
        return text;
      } catch {}
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

    const deviceInfo = JSON.stringify({
      ip,
      ua,
      platform,
      lastSeen: Date.now(),
    });

    const r = getRedis();
    await r.hset("devices", deviceId, deviceInfo);
    const deviceCount = await r.hlen("devices");

    const body = await getSubscriptionText(r);

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

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

// Фетчим подписку из GitHub raw, кешируем в Redis на 60 сек
export async function getSubscriptionText(r) {
  const cached = await r.get("sub_cache");
  if (cached) return cached;

  try {
    const resp = await fetch(RAW_URL, { headers: { "Cache-Control": "no-cache" } });
    if (resp.ok) {
      const text = await resp.text();
      await r.set("sub_cache", text, "EX", 60);
      return text;
    }
  } catch (e) {
    console.error("[SUB] Failed to fetch raw:", e.message);
  }

  // Fallback — файл из бандла
  try {
    const { readFileSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { fileURLToPath } = await import("url");
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const p of [join(dir, "..", "PiskoVPN.txt"), join(process.cwd(), "PiskoVPN.txt")]) {
      try { return readFileSync(p, "utf-8"); } catch {}
    }
  } catch {}

  throw new Error("Subscription text not found");
}

export default async function handler(req, res) {
  try {
    const r = getRedis();

    // Быстрый путь — отдаём из кеша мгновенно
    const cached = await r.get("sub_cache");
    let body;
    if (cached) {
      body = cached;
    } else {
      try {
        const resp = await fetch(RAW_URL, { signal: AbortSignal.timeout(4000) });
        if (resp.ok) {
          body = await resp.text();
          r.set("sub_cache", body, "EX", 60).catch(() => {});
        }
      } catch {}
      if (!body) {
        // Fallback — файл из бандла
        try {
          const { readFileSync } = await import("fs");
          const { dirname, join } = await import("path");
          const { fileURLToPath } = await import("url");
          const dir = dirname(fileURLToPath(import.meta.url));
          for (const p of [join(dir, "..", "PiskoVPN.txt"), join(process.cwd(), "PiskoVPN.txt")]) {
            try { body = readFileSync(p, "utf-8"); break; } catch {}
          }
        } catch {}
      }
      if (!body) return res.status(500).send("Subscription not found");
    }

    // Отдаём сразу
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("profile-update-interval", "5");
    res.status(200).send(body);

    // Аналитика — после ответа, fire-and-forget
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
      const ua = req.headers["user-agent"] || "unknown";
      const hwid = req.headers["x-hwid"] || req.headers["hwid"] || null;
      const deviceId = hwid || `${ip}_${ua}`;
      const platform = detectPlatform(ua);
      const buildMatch = body.match(/^#\s*build[:\-]\s*(.+)/im);
      const build = buildMatch ? buildMatch[1].trim() : "unknown";

      let geo = { country: "??", city: "" };
      const geoCache = ip !== "unknown" ? await r.get(`geo:${ip}`) : null;
      if (geoCache) try { geo = JSON.parse(geoCache); } catch {}

      r.hset("devices", deviceId, JSON.stringify({ ip, ua, platform, build, geo, lastSeen: Date.now() })).catch(() => {});
      const today = new Date().toISOString().slice(0, 10);
      r.pfadd(`daily:${today}`, deviceId).catch(() => {});
      r.expire(`daily:${today}`, 2592000).catch(() => {});

      if (ip !== "unknown" && !geoCache) {
        fetch(`http://ip-api.com/json/${ip}?fields=status,countryCode,city`, { signal: AbortSignal.timeout(2000) })
          .then(resp => resp.json())
          .then(data => {
            if (data.status === "success") {
              r.set(`geo:${ip}`, JSON.stringify({ country: data.countryCode || "??", city: data.city || "" }), "EX", 86400).catch(() => {});
            }
          }).catch(() => {});
      }
    } catch {}
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    if (!res.headersSent) res.status(500).send("Internal server error");
  }
}

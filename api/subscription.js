import Redis from "ioredis";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/FivFiv133/PiskoVPN/refs/heads/main/PiskoVPN.txt";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
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

    const response = await fetch(GITHUB_RAW_URL, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch subscription");
    }

    const body = await response.text();

    console.log(`[SUB] ${new Date().toISOString()} | ${platform} | IP: ${ip} | Total: ${deviceCount}`);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    res.status(500).send("Internal server error");
  }
}

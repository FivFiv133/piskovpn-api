import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
  }
  return redis;
}

export default async function handler(req, res) {
  try {
    const r = getRedis();
    const allDevices = await r.hgetall("devices");
    const now = Date.now();
    const entries = Object.entries(allDevices);

    const active24h = entries.filter(([, ts]) => now - Number(ts) < 86400000).length;
    const active7d = entries.filter(([, ts]) => now - Number(ts) < 604800000).length;

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({
      total_devices: entries.length,
      active_24h: active24h,
      active_7d: active7d,
      updated: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[STATS] Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

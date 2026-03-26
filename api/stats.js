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

    const devices = [];
    let mobile = 0;
    let desktop = 0;
    let unknown = 0;
    let active24h = 0;
    let active7d = 0;

    for (const [id, raw] of Object.entries(allDevices)) {
      let info;
      try {
        info = JSON.parse(raw);
      } catch {
        info = { ip: "unknown", platform: "unknown", lastSeen: Number(raw) || 0 };
      }

      const lastSeen = info.lastSeen || 0;
      const age = now - lastSeen;

      if (age < 86400000) active24h++;
      if (age < 604800000) active7d++;

      if (info.platform === "mobile") mobile++;
      else if (info.platform === "desktop") desktop++;
      else unknown++;

      devices.push({
        ip: info.ip || "unknown",
        platform: info.platform || "unknown",
        lastSeen: lastSeen ? new Date(lastSeen).toISOString() : "unknown",
      });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const data = {
      total_devices: devices.length,
      active_24h: active24h,
      active_7d: active7d,
      by_platform: { mobile, desktop, unknown },
      devices,
      updated: new Date().toISOString(),
    };
    res.status(200).send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[STATS] Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

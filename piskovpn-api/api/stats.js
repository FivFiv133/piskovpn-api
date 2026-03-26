import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const allDevices = (await kv.hgetall("devices")) || {};
    const now = Date.now();
    const entries = Object.entries(allDevices);

    // Активные за последние 24 часа
    const active24h = entries.filter(([, ts]) => now - ts < 86400000).length;
    // Активные за последние 7 дней
    const active7d = entries.filter(([, ts]) => now - ts < 604800000).length;

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

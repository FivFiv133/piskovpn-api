import { kv } from "@vercel/kv";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/FivFiv133/PiskoVPN/refs/heads/main/PiskoVPN.txt";

export default async function handler(req, res) {
  try {
    // Определяем устройство
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    const hwid = req.headers["x-hwid"] || req.headers["hwid"] || null;

    // Уникальный ключ устройства
    const deviceId = hwid || `${ip}_${ua}`;

    // Сохраняем устройство в KV с временем последнего запроса
    await kv.hset("devices", { [deviceId]: Date.now() });

    // Считаем общее количество устройств
    const allDevices = await kv.hgetall("devices") || {};
    const deviceCount = Object.keys(allDevices).length;

    // Получаем подписку с GitHub
    const response = await fetch(GITHUB_RAW_URL, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch subscription");
    }

    const body = await response.text();

    console.log(`[SUB] ${new Date().toISOString()} | Device: ${deviceId} | Total devices: ${deviceCount}`);

    // HTTP-заголовки для HAPP
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    res.status(500).send("Internal server error");
  }
}

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/FivFiv133/PiskoVPN/refs/heads/main/PiskoVPN.txt";

export default async function handler(req, res) {
  try {
    const response = await fetch(GITHUB_RAW_URL, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch subscription from GitHub");
    }

    const body = await response.text();

    // Логируем базовую инфу о запросе
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const ua = req.headers["user-agent"] || "unknown";
    console.log(`[SUB] ${new Date().toISOString()} | IP: ${ip} | UA: ${ua}`);

    // Отдаём как текстовый файл с нужными заголовками
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(body);
  } catch (err) {
    console.error("[SUB] Error:", err.message);
    res.status(500).send("Internal server error");
  }
}

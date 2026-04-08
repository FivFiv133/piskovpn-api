import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null;
        return Math.min(times * 200, 1000);
      },
    });
    redis.on("error", () => {});
  }
  return redis;
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const format = url.searchParams.get("format");
  const start = Date.now();
  const checks = {};

  // Redis check
  try {
    const r = getRedis();
    const t0 = Date.now();
    await Promise.race([
      r.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    checks.redis = { status: "ok", ping: Date.now() - t0 };
  } catch (e) {
    checks.redis = { status: "error", error: e.message };
  }

  // GitHub raw check
  try {
    const t0 = Date.now();
    const rawUrl = process.env.RAW_SUB_URL || "https://raw.githubusercontent.com/FivFiv133/piskovpn-api/refs/heads/main/PiskoVPN.txt";
    const resp = await fetch(rawUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    checks.github = { status: resp.ok ? "ok" : "error", code: resp.status, ping: Date.now() - t0 };
  } catch (e) {
    checks.github = { status: "error", error: e.message };
  }

  // Vercel function info
  checks.runtime = {
    status: "ok",
    region: process.env.VERCEL_REGION || "unknown",
    node: process.version,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };

  const allOk = checks.redis.status === "ok" && checks.github.status === "ok";
  const totalTime = Date.now() - start;

  if (format === "json") {
    res.setHeader("Cache-Control", "no-cache");
    return res.status(allOk ? 200 : 503).json({ status: allOk ? "healthy" : "degraded", checks, totalTime });
  }

  // HTML page
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.status(allOk ? 200 : 503).send(getHealthHTML(checks, allOk, totalTime));
}

function getHealthHTML(checks, allOk, totalTime) {
  const dot = (ok) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ok ? '#34d399' : '#f87171'};box-shadow:0 0 8px ${ok ? '#34d39966' : '#f8717166'}"></span>`;
  const card = (title, check) => {
    const ok = check.status === "ok";
    const border = ok ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)";
    let details = "";
    if (check.ping !== undefined) details += `<div style="color:#888;font-size:12px">${check.ping}ms</div>`;
    if (check.error) details += `<div style="color:#f87171;font-size:12px">${esc(check.error)}</div>`;
    if (check.region) details += `<div style="color:#888;font-size:12px">Region: ${esc(check.region)}</div>`;
    if (check.node) details += `<div style="color:#888;font-size:12px">${esc(check.node)} · ${check.memory}MB · ${check.uptime}s up</div>`;
    if (check.code) details += `<div style="color:#888;font-size:12px">HTTP ${check.code}</div>`;
    return `<div style="background:rgba(20,18,35,0.5);border:1px solid ${border};border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px">${dot(ok)}<span style="color:#fff;font-weight:600;font-size:14px">${title}</span></div>
      ${details}
    </div>`;
  };

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiskoVPN — Health</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#07060b;color:#e0e0e0;min-height:100vh;padding:20px}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 20%,${allOk ? '#34d39908' : '#f8717108'} 0%,transparent 70%);pointer-events:none}
  .wrap{max-width:600px;margin:40px auto;position:relative;z-index:1}
  .header{text-align:center;margin-bottom:32px}
  .status-big{font-size:48px;font-weight:700;letter-spacing:-2px;margin-bottom:4px;color:${allOk ? '#34d399' : '#f87171'}}
  .sub{color:#64607a;font-size:14px}
  .cards{display:grid;gap:12px;margin-bottom:24px}
  .actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .btn{background:rgba(20,18,35,0.5);border:1px solid rgba(124,92,252,0.15);color:#a78bfa;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;text-decoration:none;transition:all .25s;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{border-color:#7c5cfc44;background:rgba(124,92,252,0.08)}
  .time{text-align:center;margin-top:16px;color:#3a3650;font-size:12px}
  @media(max-width:480px){.wrap{margin:20px auto}.status-big{font-size:36px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="status-big">${allOk ? 'Healthy' : 'Degraded'}</div>
    <div class="sub">PiskoVPN System Status</div>
  </div>
  <div class="cards">
    ${card('Redis', checks.redis)}
    ${card('GitHub Raw', checks.github)}
    ${card('Runtime', checks.runtime)}
  </div>
  <div class="actions">
    <a href="/stats" class="btn">← Admin Panel</a>
    <a href="/health?format=json" class="btn">JSON</a>
    <button class="btn" onclick="location.reload()">↻ Refresh</button>
  </div>
  <div class="time">Checked in ${totalTime}ms</div>
</div>
</body>
</html>`;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

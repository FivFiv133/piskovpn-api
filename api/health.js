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
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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

  // Vercel function runtime info
  checks.runtime = {
    status: "ok",
    region: process.env.VERCEL_REGION || "iad1 (Global)",
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

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getHealthHTML(checks, allOk, totalTime) {
  const isRedisOk = checks.redis?.status === "ok";
  const isGhOk = checks.github?.status === "ok";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiskoVPN — System Diagnostics</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #060609;
    --surface: rgba(18, 16, 28, 0.6);
    --surface-hover: rgba(28, 25, 42, 0.8);
    --border: rgba(139, 92, 246, 0.12);
    --border-glow: rgba(139, 92, 246, 0.35);
    --primary: #8b5cf6;
    --primary-light: #a78bfa;
    --success: #10b981;
    --danger: #f43f5e;
    --text: #f1f5f9;
    --text-muted: #64748b;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: 
      radial-gradient(circle at 50% 10%, ${allOk ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)'} 0%, transparent 60%),
      radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
      radial-gradient(circle at 20% 70%, rgba(56, 189, 248, 0.04) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
  }
  .container {
    width: 100%;
    max-width: 640px;
    position: relative;
    z-index: 1;
    animation: fadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .hero-card {
    background: var(--surface);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid ${allOk ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)'};
    border-radius: 24px;
    padding: 32px 28px;
    text-align: center;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px ${allOk ? 'rgba(16, 185, 129, 0.06)' : 'rgba(244, 63, 94, 0.06)'};
    margin-bottom: 16px;
    position: relative;
    overflow: hidden;
  }
  .status-ring-wrap {
    width: 76px;
    height: 76px;
    margin: 0 auto 20px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .status-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid ${allOk ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)'};
    animation: pulseRing 2.4s infinite cubic-bezier(0.4, 0, 0.6, 1);
  }
  @keyframes pulseRing {
    0% { transform: scale(0.92); opacity: 0.8; }
    50% { transform: scale(1.15); opacity: 0.2; }
    100% { transform: scale(0.92); opacity: 0.8; }
  }
  .status-icon-circle {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: ${allOk ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #f43f5e, #e11d48)'};
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    box-shadow: 0 0 24px ${allOk ? 'rgba(16, 185, 129, 0.5)' : 'rgba(244, 63, 94, 0.5)'};
  }
  .status-icon-circle svg { width: 28px; height: 28px; stroke-width: 2.5; }
  h1 {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: #fff;
    margin-bottom: 6px;
  }
  .subtitle {
    font-size: 13px;
    color: var(--text-muted);
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .item-card {
    background: var(--surface);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .item-card:hover {
    background: var(--surface-hover);
    border-color: var(--border-glow);
    transform: translateY(-2px);
  }
  .item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .item-title {
    font-size: 13px;
    font-weight: 700;
    color: #cbd5e1;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge-pill {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 20px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .badge-pill.ok {
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }
  .badge-pill.err {
    background: rgba(244, 63, 94, 0.15);
    color: #f87171;
    border: 1px solid rgba(244, 63, 94, 0.3);
  }
  .item-metric {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.02em;
  }
  .item-metric span {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
  }
  .item-meta {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .runtime-panel {
    background: var(--surface);
    backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 18px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .runtime-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .runtime-stat .label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .runtime-stat .val {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #e2e8f0;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .btn {
    background: rgba(139, 92, 246, 0.1);
    border: 1px solid rgba(139, 92, 246, 0.2);
    color: var(--primary-light);
    padding: 10px 20px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .btn:hover {
    background: rgba(139, 92, 246, 0.2);
    border-color: rgba(139, 92, 246, 0.4);
    transform: translateY(-1px);
    color: #fff;
  }
  .btn.primary {
    background: linear-gradient(135deg, #8b5cf6, #6d28d9);
    border: none;
    color: #fff;
    box-shadow: 0 4px 16px rgba(139, 92, 246, 0.3);
  }
  .btn.primary:hover {
    box-shadow: 0 6px 24px rgba(139, 92, 246, 0.45);
  }
  .footer {
    text-align: center;
    margin-top: 18px;
    font-size: 12px;
    color: #475569;
    font-family: 'JetBrains Mono', monospace;
  }
</style>
</head>
<body>
<div class="container">
  <div class="hero-card">
    <div class="status-ring-wrap">
      <div class="status-ring"></div>
      <div class="status-icon-circle">
        ${allOk 
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
        }
      </div>
    </div>
    <h1>${allOk ? 'All Systems Operational' : 'Degraded Performance'}</h1>
    <div class="subtitle">PiskoVPN Infrastructure &amp; API Health Monitor</div>
  </div>

  <div class="grid">
    <!-- Redis Card -->
    <div class="item-card">
      <div class="item-header">
        <span class="item-title">
          <svg style="width:16px;height:16px;color:#a78bfa" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/></svg>
          Redis Database
        </span>
        <span class="badge-pill ${isRedisOk ? 'ok' : 'err'}">${isRedisOk ? 'Connected' : 'Error'}</span>
      </div>
      <div class="item-metric">
        ${isRedisOk ? checks.redis.ping : '--'} <span>ms</span>
      </div>
      <div class="item-meta">
        ${isRedisOk ? 'Read/Write device analytics and cache active' : `<span style="color:#f87171">${esc(checks.redis.error)}</span>`}
      </div>
    </div>

    <!-- GitHub Card -->
    <div class="item-card">
      <div class="item-header">
        <span class="item-title">
          <svg style="width:16px;height:16px;color:#38bdf8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
          GitHub Feed
        </span>
        <span class="badge-pill ${isGhOk ? 'ok' : 'err'}">${isGhOk ? 'Available' : 'Error'}</span>
      </div>
      <div class="item-metric">
        ${isGhOk ? checks.github.ping : '--'} <span>ms</span>
      </div>
      <div class="item-meta">
        ${isGhOk ? `HTTP ${checks.github.code} · Master subscription mirror live` : `<span style="color:#f87171">${esc(checks.github.error)}</span>`}
      </div>
    </div>
  </div>

  <!-- Runtime Info -->
  <div class="runtime-panel">
    <div class="runtime-stat">
      <span class="label">Compute Region</span>
      <span class="val">${esc(checks.runtime.region)}</span>
    </div>
    <div class="runtime-stat">
      <span class="label">Node Engine</span>
      <span class="val">${esc(checks.runtime.node)}</span>
    </div>
    <div class="runtime-stat">
      <span class="label">Memory Usage</span>
      <span class="val">${checks.runtime.memory} MB</span>
    </div>
    <div class="runtime-stat">
      <span class="label">Server Uptime</span>
      <span class="val">${checks.runtime.uptime}s</span>
    </div>
  </div>

  <div class="actions">
    <a href="/stats" class="btn primary">
      <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
      Admin Panel
    </a>
    <a href="/health?format=json" class="btn">
      <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>
      Raw JSON
    </a>
    <button class="btn" onclick="location.reload()">
      <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
      Re-check
    </button>
  </div>

  <div class="footer">Checked in ${totalTime}ms · PiskoVPN Telemetry Core</div>
</div>
</body>
</html>`;
}


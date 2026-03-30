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

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";

function checkAuth(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.split(" ")[1], "base64").toString();
  const [user, pass] = decoded.split(":");
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// API: возвращает JSON-данные
async function apiData(req, res) {
  const r = getRedis();
  const allDevices = await r.hgetall("devices");
  const now = Date.now();

  const devices = [];
  let mobile = 0, desktop = 0, unknown = 0, active24h = 0, active7d = 0;

  for (const [id, raw] of Object.entries(allDevices)) {
    let info;
    try { info = JSON.parse(raw); } catch { info = { ip: "unknown", platform: "unknown", lastSeen: 0 }; }

    const lastSeen = info.lastSeen || 0;
    const age = now - lastSeen;
    if (age < 86400000) active24h++;
    if (age < 604800000) active7d++;
    if (info.platform === "mobile") mobile++;
    else if (info.platform === "desktop") desktop++;
    else unknown++;

    devices.push({
      id: id.substring(0, 16) + "…",
      ip: info.ip || "unknown",
      ua: info.ua || "unknown",
      platform: info.platform || "unknown",
      lastSeen,
      lastSeenISO: lastSeen ? new Date(lastSeen).toISOString() : "never",
    });
  }

  devices.sort((a, b) => b.lastSeen - a.lastSeen);

  return res.status(200).json({
    total: devices.length, active24h, active7d,
    platforms: { mobile, desktop, unknown },
    devices,
    version: process.env.VPN_VERSION || "v0.1.4-X",
    updated: new Date().toISOString(),
  });
}

// API: удалить устройство
async function apiDeleteDevice(req, res) {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const r = getRedis();
  await r.hdel("devices", deviceId);
  return res.status(200).json({ ok: true });
}

// API: очистить неактивные (старше N дней)
async function apiPurge(req, res) {
  const days = parseInt(req.query?.days || "30", 10);
  const r = getRedis();
  const all = await r.hgetall("devices");
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const [id, raw] of Object.entries(all)) {
    let info;
    try { info = JSON.parse(raw); } catch { continue; }
    if ((info.lastSeen || 0) < cutoff) {
      await r.hdel("devices", id);
      removed++;
    }
  }
  return res.status(200).json({ removed });
}


// Главный handler
export default async function handler(req, res) {
  // Basic Auth
  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="PiskoVPN Admin"');
    return res.status(401).send("Unauthorized");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  try {
    if (action === "data") return await apiData(req, res);
    if (action === "delete" && req.method === "POST") return await apiDeleteDevice(req, res);
    if (action === "purge") return await apiPurge(req, res);

    // Отдаём HTML-панель
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.status(200).send(getHTML());
  } catch (err) {
    console.error("[STATS] Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiskoVPN — Admin Panel</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f0f1a;
    color: #e0e0e0;
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    padding: 20px 30px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #2a2a4a;
  }
  .header h1 { font-size: 22px; color: #fff; }
  .header h1 span { color: #7c5cfc; }
  .header .version {
    background: #7c5cfc33;
    color: #a78bfa;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 13px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    padding: 24px 30px;
  }
  .card {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
    transition: transform 0.2s, border-color 0.2s;
  }
  .card:hover { transform: translateY(-2px); border-color: #7c5cfc; }
  .card .num { font-size: 36px; font-weight: 700; color: #fff; }
  .card .label { font-size: 13px; color: #888; margin-top: 4px; }
  .card.purple .num { color: #a78bfa; }
  .card.green .num { color: #34d399; }
  .card.yellow .num { color: #fbbf24; }
  .card.red .num { color: #f87171; }
  .toolbar {
    padding: 0 30px 16px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: center;
  }
  .toolbar input {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    color: #e0e0e0;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 14px;
    flex: 1;
    min-width: 200px;
  }
  .toolbar input:focus { outline: none; border-color: #7c5cfc; }
  .toolbar select, .btn {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    color: #e0e0e0;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .btn:hover { border-color: #7c5cfc; }
  .btn.danger { border-color: #f87171; color: #f87171; }
  .btn.danger:hover { background: #f8717122; }
  .btn.refresh { border-color: #34d399; color: #34d399; }
  .btn.refresh:hover { background: #34d39922; }
  .table-wrap {
    padding: 0 30px 30px;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #1a1a2e;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid #2a2a4a;
  }
  th {
    background: #16213e;
    padding: 12px 16px;
    text-align: left;
    font-size: 12px;
    text-transform: uppercase;
    color: #888;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  th:hover { color: #a78bfa; }
  th.sorted-asc::after { content: " ▲"; color: #7c5cfc; }
  th.sorted-desc::after { content: " ▼"; color: #7c5cfc; }
  td {
    padding: 10px 16px;
    border-top: 1px solid #2a2a4a;
    font-size: 14px;
    white-space: nowrap;
  }
  tr:hover td { background: #ffffff08; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge.mobile { background: #7c5cfc33; color: #a78bfa; }
  .badge.desktop { background: #34d39933; color: #34d399; }
  .badge.unknown { background: #fbbf2433; color: #fbbf24; }
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .status-dot.online { background: #34d399; box-shadow: 0 0 6px #34d399; }
  .status-dot.recent { background: #fbbf24; }
  .status-dot.offline { background: #666; }
  .empty { text-align: center; padding: 40px; color: #666; }
  .footer {
    text-align: center;
    padding: 16px;
    color: #444;
    font-size: 12px;
    border-top: 1px solid #2a2a4a;
  }
  @media (max-width: 600px) {
    .cards { grid-template-columns: repeat(2, 1fr); padding: 16px; }
    .toolbar { padding: 0 16px 12px; }
    .table-wrap { padding: 0 16px 16px; }
    .header { padding: 16px; }
  }
</style>
</head>
<body>
<div class="header">
  <h1>🔞 <span>PiskoVPN</span> Admin</h1>
  <div>
    <span class="version" id="ver">...</span>
    <span style="margin-left:8px;color:#666;font-size:12px" id="updated"></span>
  </div>
</div>

<div class="cards" id="cards"></div>

<div class="toolbar">
  <input type="text" id="search" placeholder="🔍 Поиск по IP, платформе, User-Agent…">
  <select id="filterPlatform">
    <option value="">Все платформы</option>
    <option value="mobile">📱 Mobile</option>
    <option value="desktop">💻 Desktop</option>
    <option value="unknown">❓ Unknown</option>
  </select>
  <select id="filterStatus">
    <option value="">Все статусы</option>
    <option value="online">🟢 Online (5 мин)</option>
    <option value="recent">🟡 Недавно (24ч)</option>
    <option value="offline">⚫ Offline</option>
  </select>
  <button class="btn refresh" onclick="loadData()">↻ Обновить</button>
  <button class="btn danger" onclick="purgeOld()">🗑 Очистить 30д+</button>
</div>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th data-col="status">Статус</th>
        <th data-col="ip">IP</th>
        <th data-col="platform">Платформа</th>
        <th data-col="ua">User-Agent</th>
        <th data-col="lastSeen">Последний визит</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<div class="footer">PiskoVPN Admin Panel · <span id="totalFooter">0</span> устройств</div>

<script>
let allDevices = [];
let sortCol = "lastSeen", sortDir = "desc";

async function loadData() {
  try {
    const r = await fetch("/stats?action=data");
    const d = await r.json();
    allDevices = d.devices || [];
    document.getElementById("ver").textContent = d.version;
    document.getElementById("updated").textContent = "Обновлено: " + new Date(d.updated).toLocaleString("ru");
    renderCards(d);
    renderTable();
  } catch(e) { console.error(e); }
}

function renderCards(d) {
  document.getElementById("cards").innerHTML = [
    card(d.total, "Всего устройств", "purple"),
    card(d.active24h, "Активных за 24ч", "green"),
    card(d.active7d, "Активных за 7д", "yellow"),
    card(d.platforms?.mobile || 0, "📱 Mobile", ""),
    card(d.platforms?.desktop || 0, "💻 Desktop", ""),
    card(d.platforms?.unknown || 0, "❓ Unknown", ""),
  ].join("");
}

function card(num, label, cls) {
  return \`<div class="card \${cls}"><div class="num">\${num}</div><div class="label">\${label}</div></div>\`;
}

function getStatus(ts) {
  if (!ts) return "offline";
  const age = Date.now() - ts;
  if (age < 300000) return "online";
  if (age < 86400000) return "recent";
  return "offline";
}

function timeAgo(ts) {
  if (!ts) return "никогда";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + " сек назад";
  if (s < 3600) return Math.floor(s/60) + " мин назад";
  if (s < 86400) return Math.floor(s/3600) + " ч назад";
  return Math.floor(s/86400) + " д назад";
}

function renderTable() {
  const search = document.getElementById("search").value.toLowerCase();
  const fp = document.getElementById("filterPlatform").value;
  const fs = document.getElementById("filterStatus").value;

  let filtered = allDevices.filter(d => {
    if (search && !((d.ip+d.ua+d.platform).toLowerCase().includes(search))) return false;
    if (fp && d.platform !== fp) return false;
    if (fs && getStatus(d.lastSeen) !== fs) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === "string") { va = va.toLowerCase(); vb = (vb||"").toLowerCase(); }
    if (va < vb) return sortDir === "asc" ? -1 : 1;
    if (va > vb) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  document.querySelectorAll("th").forEach(th => {
    th.classList.remove("sorted-asc","sorted-desc");
    if (th.dataset.col === sortCol) th.classList.add("sorted-" + sortDir);
  });

  const tbody = document.getElementById("tbody");
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Нет устройств</td></tr>';
  } else {
    tbody.innerHTML = filtered.map(d => {
      const st = getStatus(d.lastSeen);
      const uaShort = d.ua.length > 60 ? d.ua.substring(0,60) + "…" : d.ua;
      return \`<tr>
        <td><span class="status-dot \${st}"></span>\${st === "online" ? "Online" : st === "recent" ? "Недавно" : "Offline"}</td>
        <td>\${esc(d.ip)}</td>
        <td><span class="badge \${d.platform}">\${d.platform}</span></td>
        <td title="\${esc(d.ua)}">\${esc(uaShort)}</td>
        <td>\${timeAgo(d.lastSeen)}</td>
      </tr>\`;
    }).join("");
  }
  document.getElementById("totalFooter").textContent = filtered.length;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

document.querySelectorAll("th[data-col]").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "asc"; }
    renderTable();
  });
});

document.getElementById("search").addEventListener("input", renderTable);
document.getElementById("filterPlatform").addEventListener("change", renderTable);
document.getElementById("filterStatus").addEventListener("change", renderTable);

async function purgeOld() {
  if (!confirm("Удалить устройства неактивные 30+ дней?")) return;
  const r = await fetch("/stats?action=purge&days=30");
  const d = await r.json();
  alert("Удалено: " + d.removed);
  loadData();
}

loadData();
setInterval(loadData, 30000);
</script>
</body>
</html>`;
}

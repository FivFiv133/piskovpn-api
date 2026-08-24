import Redis from "ioredis";
import crypto from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { detectPlatform, parseClient, parseBuildFromSub, normalizeBuild } from "./device-utils.js";

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

const TOKEN_SECRET = process.env.TOKEN_SECRET || "piskovpn-secret-key-change-me";

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const parts = decoded.split(":");
    if (parts.length < 3) return false;
    const hmac = parts.pop();
    const payload = parts.join(":");
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
    return hmac === expected;
  } catch { return false; }
}

function parseCookies(req) {
  const obj = {};
  const header = req.headers.cookie || "";
  header.split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    if (k) obj[k.trim()] = decodeURIComponent(v.join("="));
  });
  return obj;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return cookies.auth_token && verifyToken(cookies.auth_token);
}

function parseVlessLinks(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  let text = rawText.trim();
  if (!text.includes("://")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8");
    } catch {}
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((line) => {
    try {
      const u = new URL(line);
      const remark = decodeURIComponent(u.hash.slice(1));
      return {
        url: line,
        protocol: u.protocol.replace(":", ""),
        address: u.hostname,
        port: u.port || "443",
        uuid: u.username,
        remark,
        params: Object.fromEntries(u.searchParams.entries()),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Happ emoji flag formatter
const COUNTRY_FLAGS = {
  "автовыбор": "🇪🇺 🔄",
  "нидерланд": "🇳🇱 ⚡",
  "швейцар": "🇨🇭 ⚡",
  "герман": "🇩🇪 ⚡",
  "испан": "🇪🇸 ⚡",
  "сингапур": "🇸🇬 ⚡",
  "сша": "🇺🇸 ⚡",
  "литв": "🇱🇹 ⚡",
  "латви": "🇱🇻 ⚡",
  "эстон": "🇪🇪 ⚡",
  "австри": "🇦🇹 ⚡",
  "польш": "🇵🇱 ⚡",
  "франц": "🇫🇷 🛡️",
  "росси": "🇷🇺 🔄",
  "обход": "🛡️",
};

function formatRemarkForHapp(rawRemark) {
  let remark = (rawRemark || "").trim();
  if (/^(\uD83C[\uDDE6-\uDDFF]){2}/.test(remark)) {
    return remark;
  }
  const lower = remark.toLowerCase();
  for (const [key, prefix] of Object.entries(COUNTRY_FLAGS)) {
    if (lower.includes(key)) {
      const cleanName = remark.replace(/^[\s\p{Emoji}\u200d\uFE0F]+/gu, "").trim();
      return `${prefix} ${cleanName || remark}`;
    }
  }
  return `🌐 ${remark}`;
}

function convertVlessToJson(vlessItems) {
  return vlessItems.map((item) => {
    const params = item.params || {};
    const streamSettings = {
      network: params.type || "tcp",
      security: params.security || "none",
    };

    if (params.security === "reality") {
      streamSettings.realitySettings = {
        show: false,
        publicKey: params.pbk || "",
        fingerprint: params.fp || "chrome",
        serverName: params.sni || item.address,
        shortId: params.sid || "",
        spiderX: params.spx || "/",
      };
    } else if (params.security === "tls") {
      streamSettings.tlsSettings = {
        allowInsecure: false,
        serverName: params.sni || item.address,
        fingerprint: params.fp || "chrome",
        alpn: params.alpn ? params.alpn.split(",") : undefined,
      };
    }

    if (params.type === "grpc") {
      streamSettings.grpcSettings = {
        serviceName: params.serviceName || params.path || "",
        multiMode: params.mode === "multi",
      };
    } else if (params.type === "ws") {
      streamSettings.wsSettings = {
        path: params.path || "/",
        headers: { Host: params.host || params.sni || item.address },
      };
    }

    return {
      remarks: item.remark,
      outbounds: [
        {
          tag: "proxy",
          protocol: item.protocol,
          settings: {
            vnext: [
              {
                address: item.address,
                port: parseInt(item.port, 10) || 443,
                users: [
                  {
                    id: item.uuid,
                    encryption: params.encryption || "none",
                    flow: params.flow || undefined,
                    level: 0,
                  },
                ],
              },
            ],
          },
          streamSettings,
        },
      ],
    };
  });
}

async function pushToGithub(path, content, ghToken, repo) {
  if (!ghToken) return { ok: false, error: "GITHUB_TOKEN не настроен" };
  try {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
    const getResp = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${ghToken}`, "User-Agent": "PiskoVPN-Sync" },
    });
    let sha = undefined;
    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
    }

    const putPayload = {
      message: `Update ${path} via Sync tool`,
      content: Buffer.from(content, "utf8").toString("base64"),
    };
    if (sha) putPayload.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        "User-Agent": "PiskoVPN-Sync",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(putPayload),
    });
    const putData = await putResp.json();
    return putResp.ok ? { ok: true, commit: putData.commit?.sha?.slice(0, 7) } : { ok: false, error: putData.message };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const action = url.searchParams.get("action");

  if (!isAuthed(req)) {
    if (req.method === "POST") return res.status(401).json({ error: "Unauthorized" });
    return res.status(401).send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>PiskoVPN · Авторизация</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
      <style>body{background:#050508;color:#f1f5f9;font-family:'Plus Jakarta Sans',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
      .box{background:#0e1017;padding:36px;border-radius:20px;border:1px solid #1e2235;text-align:center;width:340px;box-shadow:0 20px 40px -15px rgba(0,0,0,0.7);}
      .lock-icon{width:48px;height:48px;border-radius:14px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);display:inline-flex;align-items:center;justify-content:center;color:#c4b5fd;margin-bottom:16px;}
      h2{font-size:18px;font-weight:800;margin-bottom:8px;}
      p{color:#64748b;font-size:13px;margin-bottom:24px;line-height:1.5;}
      a{background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 20px;border-radius:10px;display:inline-block;transition:all 0.2s;}
      a:hover{filter:brightness(1.15);transform:translateY(-1px);}</style></head>
      <body><div class="box">
        <div class="lock-icon">
          <svg style="width:24px;height:24px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h2>Требуется вход</h2>
        <p>Войдите в панель управления для доступа к сверке конфигураций</p>
        <a href="/stats">Перейти к авторизации →</a>
      </div></body></html>
    `);
  }

  // API Action: Сверить конфиги
  if (req.method === "POST" && action === "fetch") {
    try {
      const { upstreamUrl, customHeaders } = req.body || {};
      const targetUrl = (upstreamUrl || "").trim() || "https://sub.medoed.store/4hokxg5sBXqNRXnL";

      const headers = {
        "User-Agent": "Happ/3.3.6/Windows/2607171516500",
        "x-hwid": "2607171516500",
        ...(customHeaders || {}),
      };

      const t0 = Date.now();
      const resp = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(6000) });
      const fetchTime = Date.now() - t0;

      if (!resp.ok) {
        return res.status(400).json({ error: `Ошибка источника: HTTP ${resp.status} ${resp.statusText}` });
      }

      const rawSub = await resp.text();
      let decodedSub = rawSub;
      if (!rawSub.includes("://")) {
        try { decodedSub = Buffer.from(rawSub, "base64").toString("utf8"); } catch {}
      }

      if (decodedSub.includes("App not supported")) {
        return res.status(400).json({ error: "Источник отклонил запрос: App not supported. Проверьте заголовки/HWID." });
      }

      const upstreamItems = parseVlessLinks(decodedSub);
      if (!upstreamItems.length) {
        return res.status(400).json({ error: "В ответе источника не найдено рабочих VLESS ссылок." });
      }

      const r = getRedis();
      const { getSubscriptionText } = await import("./subscription.js");
      const currentTxt = await getSubscriptionText(r).catch(() => "");
      const currentItems = parseVlessLinks(currentTxt);

      const currentBuildNum = parseInt(parseBuildFromSub(currentTxt) || "66", 10);
      const nextBuildNum = isNaN(currentBuildNum) ? 67 : currentBuildNum + 1;

      // Анализ различий (Diff)
      const added = [];
      const modified = [];
      const unchanged = [];
      const currentMap = new Map();

      currentItems.forEach((item) => {
        const key = `${item.address}:${item.port}`;
        currentMap.set(key, item);
      });

      const processedUpstream = upstreamItems.map((up) => {
        const key = `${up.address}:${up.port}`;
        const curr = currentMap.get(key);
        const formattedRemark = formatRemarkForHapp(up.remark);
        up.formattedRemark = formattedRemark;

        let status = "added";
        let changeDesc = "";

        if (curr) {
          currentMap.delete(key);
          const sameUuid = curr.uuid === up.uuid;
          const samePbk = curr.params?.pbk === up.params?.pbk;
          const sameSni = curr.params?.sni === up.params?.sni;
          const sameType = curr.params?.type === up.params?.type;

          if (sameUuid && samePbk && sameSni && sameType) {
            status = "unchanged";
            unchanged.push(up);
          } else {
            status = "modified";
            const changes = [];
            if (!sameUuid) changes.push("UUID");
            if (!samePbk) changes.push("Reality PBK");
            if (!sameSni) changes.push("SNI");
            if (!sameType) changes.push("Type");
            changeDesc = `Изменено: ${changes.join(", ")}`;
            modified.push({ ...up, changeDesc });
          }
        } else {
          status = "added";
          added.push(up);
        }

        return { ...up, status, changeDesc };
      });

      const removed = Array.from(currentMap.values()).map((item) => ({
        ...item,
        status: "removed",
        changeDesc: "Удален в источнике",
      }));

      // Формируем готовый TXT
      const updatedUrls = processedUpstream.map((item) => {
        try {
          const u = new URL(item.url);
          u.hash = "#" + encodeURIComponent(item.formattedRemark);
          return u.toString();
        } catch {
          return item.url;
        }
      });

      const previewTxt = [
        "# profile-title: 💎 PiskoVPN 💎",
        "# profile-update-interval: 1",
        `# announce: Версия: v0.2.1-X | build-${nextBuildNum}`,
        "# support-url: https://t.me/piskovpn_bot",
        `# build-${nextBuildNum}`,
        "",
        ...updatedUrls,
      ].join("\n");

      const previewJsonItems = convertVlessToJson(processedUpstream.map(p => ({ ...p, remark: p.formattedRemark })));

      return res.status(200).json({
        ok: true,
        fetchTime,
        upstreamCount: upstreamItems.length,
        currentCount: currentItems.length,
        currentBuild: currentBuildNum,
        nextBuild: nextBuildNum,
        diff: {
          added,
          modified,
          removed,
          unchanged,
        },
        items: [...processedUpstream, ...removed],
        previewTxt,
        previewJson: JSON.stringify(previewJsonItems, null, 2),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // API Action: Применить изменения
  if (req.method === "POST" && action === "apply") {
    try {
      const { txt, json, build } = req.body || {};
      if (!txt || typeof txt !== "string") {
        return res.status(400).json({ error: "Пустой текст подписки" });
      }

      const r = getRedis();
      const repo = process.env.GITHUB_REPO || "FivFiv133/piskovpn-api";
      const ghToken = process.env.GITHUB_TOKEN;

      // 1. Сохраняем в Redis
      await r.set("sub_cache", txt, "EX", 86400).catch(() => {});
      if (json) {
        await r.set("sub_json_cache", json, "EX", 86400).catch(() => {});
      }

      // 2. Пушим в GitHub
      const ghTxt = await pushToGithub("PiskoVPN.txt", txt, ghToken, repo);
      let ghJson = null;
      if (json) {
        ghJson = await pushToGithub("PiskoVPN.json", json, ghToken, repo);
      }

      return res.status(200).json({
        ok: true,
        build: build || "66",
        github: { txt: ghTxt, json: ghJson },
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // HTML Dashboard
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>PiskoVPN · Сверка конфигов</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #050508;
      --card: #0e1017;
      --card-inner: #131722;
      --border: #1e2235;
      --border-focus: #3b4261;
      --accent: #8b5cf6;
      --accent-glow: rgba(139,92,246,0.18);
      --cyan: #06b6d4;
      --green: #10b981;
      --green-bg: rgba(16,185,129,0.12);
      --yellow: #f59e0b;
      --yellow-bg: rgba(245,158,11,0.12);
      --red: #f43f5e;
      --red-bg: rgba(244,63,94,0.12);
      --text: #f1f5f9;
      --text-muted: #64748b;
      --text-sub: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      padding: 24px 20px 48px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(139,92,246,0.25), rgba(6,182,212,0.15));
      border: 1px solid rgba(139,92,246,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #c4b5fd;
      box-shadow: 0 0 16px rgba(139,92,246,0.2);
    }
    .brand-title { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
    .nav-links { display: flex; gap: 8px; align-items: center; }
    .nav-btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text-sub);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .nav-btn:hover { border-color: var(--accent); color: #fff; transform: translateY(-1px); }

    /* Bento Cards */
    .grid-top {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 24px;
    }
    @media(max-width: 800px) { .grid-top { grid-template-columns: repeat(2, 1fr); } }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .stat-title { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.05em; }
    .stat-val { font-size: 26px; font-weight: 800; font-family: 'JetBrains Mono', monospace; }
    .stat-icon {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Action bar */
    .source-box {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .source-label { font-size: 13px; font-weight: 700; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .input-row { display: flex; gap: 10px; }
    .source-input {
      flex: 1;
      background: var(--card-inner);
      border: 1px solid var(--border);
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      padding: 11px 16px;
      border-radius: 10px;
      outline: none;
      transition: all 0.2s;
    }
    .source-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(139,92,246,0.15); }
    .btn-fetch {
      background: linear-gradient(135deg, #8b5cf6, #6366f1);
      border: none;
      color: #fff;
      padding: 11px 22px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .btn-fetch:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .btn-fetch:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-apply {
      background: linear-gradient(135deg, #10b981, #059669);
      border: none;
      color: #fff;
      padding: 12px 24px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .btn-apply:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Results Table */
    .table-container {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .table-header {
      padding: 16px 22px;
      background: var(--card-inner);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { padding: 14px 20px; color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
    td { padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.03); }
    tr:hover td { background: rgba(255,255,255,0.02); }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge-added { background: var(--green-bg); color: var(--green); border: 1px solid rgba(16,185,129,0.3); }
    .badge-modified { background: var(--yellow-bg); color: var(--yellow); border: 1px solid rgba(245,158,11,0.3); }
    .badge-removed { background: var(--red-bg); color: var(--red); border: 1px solid rgba(244,63,94,0.3); }
    .badge-unchanged { background: rgba(255,255,255,0.05); color: var(--text-sub); border: 1px solid var(--border); }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #131722;
      color: #fff;
      padding: 14px 20px;
      border-radius: 12px;
      border: 1px solid var(--accent);
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      display: none;
      z-index: 1000;
      font-weight: 600;
    }
    .spinner {
      border: 2px solid rgba(255,255,255,0.2);
      border-left-color: #fff;
      border-radius: 50%;
      width: 14px;
      height: 14px;
      animation: spin 0.6s linear infinite;
      display: inline-block;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>

<svg style="display:none">
  <symbol id="i-diamond" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>
  </symbol>
  <symbol id="i-sync" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
  </symbol>
  <symbol id="i-server" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
  </symbol>
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </symbol>
  <symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </symbol>
  <symbol id="i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </symbol>
  <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </symbol>
  <symbol id="i-zap" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </symbol>
  <symbol id="i-rocket" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
  </symbol>
</svg>

<div class="container">
  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg style="width:22px;height:22px"><use href="#i-sync"/></svg>
      </div>
      <div>
        <div class="brand-title">PiskoVPN Sync & Comparator</div>
        <div style="font-size: 12px; color: var(--text-muted);">Автоматическая сверка и обновление с апстрима</div>
      </div>
    </div>
    <div class="nav-links">
      <a href="/stats" class="nav-btn">
        <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        Панель / Stats
      </a>
      <a href="/health" class="nav-btn">
        <svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        Health HUD
      </a>
    </div>
  </header>

  <!-- Top Metrics -->
  <div class="grid-top">
    <div class="stat-card">
      <div>
        <div class="stat-title">В источнике</div>
        <div class="stat-val" id="statUpstream">-</div>
      </div>
      <div class="stat-icon" style="background: rgba(139,92,246,0.12); color: #c4b5fd;">
        <svg style="width:20px;height:20px"><use href="#i-server"/></svg>
      </div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-title" style="color: var(--green);">Новых (Added)</div>
        <div class="stat-val" style="color: var(--green);" id="statAdded">-</div>
      </div>
      <div class="stat-icon" style="background: var(--green-bg); color: var(--green);">
        <svg style="width:20px;height:20px"><use href="#i-plus"/></svg>
      </div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-title" style="color: var(--yellow);">Изменено (Modified)</div>
        <div class="stat-val" style="color: var(--yellow);" id="statModified">-</div>
      </div>
      <div class="stat-icon" style="background: var(--yellow-bg); color: var(--yellow);">
        <svg style="width:20px;height:20px"><use href="#i-edit"/></svg>
      </div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-title" style="color: var(--red);">Удалено (Removed)</div>
        <div class="stat-val" style="color: var(--red);" id="statRemoved">-</div>
      </div>
      <div class="stat-icon" style="background: var(--red-bg); color: var(--red);">
        <svg style="width:20px;height:20px"><use href="#i-trash"/></svg>
      </div>
    </div>
  </div>

  <!-- Source Input Box -->
  <div class="source-box">
    <div class="source-label">
      <span>Ссылка на источник (Upstream Provider URL)</span>
      <span style="color: var(--text-muted); font-size: 11px;">Happ Client Emulation + HWID Bypass Active</span>
    </div>
    <div class="input-row">
      <input type="text" id="upstreamUrl" class="source-input" value="https://sub.medoed.store/4hokxg5sBXqNRXnL" placeholder="https://sub.provider.com/key">
      <button class="btn-fetch" id="btnFetch" onclick="fetchAndCompare()">
        <svg style="width:16px;height:16px"><use href="#i-zap"/></svg>
        <span>Сверить с источником</span>
      </button>
    </div>
  </div>

  <!-- Action apply bar -->
  <div id="applyBar" style="display: none; background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.25); border-radius: 16px; padding: 18px 24px; margin-bottom: 24px; align-items: center; justify-content: space-between;">
    <div>
      <div style="font-size: 15px; font-weight: 700; color: #fff;">Готово к применению в подписку</div>
      <div style="font-size: 12px; color: var(--text-sub);" id="applyDesc">Новый билд: 67 · Серверов: 16</div>
    </div>
    <button class="btn-apply" id="btnApply" onclick="applyChanges()">
      <svg style="width:18px;height:18px"><use href="#i-rocket"/></svg>
      <span>Применить и обновить подписку (Build + 1)</span>
    </button>
  </div>

  <!-- Servers Diff Table -->
  <div class="table-container">
    <div class="table-header">
      <div class="table-title">
        <svg style="width:16px;height:16px;color:#c4b5fd"><use href="#i-server"/></svg>
        <span>Результаты сравнения конфигураций</span>
      </div>
      <div id="tableMeta" style="font-size: 12px; color: var(--text-muted);">Нажмите «Сверить с источником» для начала</div>
    </div>
    <div style="overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>Статус</th>
            <th>Название / Remark</th>
            <th>Адрес сервера</th>
            <th>Порт</th>
            <th>Протокол / Сеть</th>
            <th>Детали изменений</th>
          </tr>
        </thead>
        <tbody id="diffBody">
          <tr>
            <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 36px;">
              Нажмите кнопку «Сверить с источником» выше, чтобы получить актуальные ноды и выявить различия
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
let lastResult = null;

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.style.borderColor = isError ? "var(--red)" : "var(--green)";
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 4000);
}

async function fetchAndCompare() {
  const btn = document.getElementById("btnFetch");
  const url = document.getElementById("upstreamUrl").value.trim();
  if (!url) return showToast("Укажите URL источника", true);

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> <span>Сверяем...</span>';

  try {
    const resp = await fetch("/api/sync?action=fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upstreamUrl: url })
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      showToast(data.error || "Ошибка сверки", true);
      return;
    }

    lastResult = data;
    renderResults(data);
    showToast("Сверка успешно завершена (" + data.fetchTime + "мс)!");
  } catch(e) {
    showToast("Ошибка сети: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg style="width:16px;height:16px"><use href="#i-zap"/></svg> <span>Сверить с источником</span>';
  }
}

function renderResults(data) {
  document.getElementById("statUpstream").innerText = data.upstreamCount;
  document.getElementById("statAdded").innerText = data.diff.added.length;
  document.getElementById("statModified").innerText = data.diff.modified.length;
  document.getElementById("statRemoved").innerText = data.diff.removed.length;

  document.getElementById("tableMeta").innerText = "Найдено: " + data.items.length + " серверов (Билд " + data.currentBuild + " → " + data.nextBuild + ")";

  const applyBar = document.getElementById("applyBar");
  applyBar.style.display = "flex";
  document.getElementById("applyDesc").innerText = "Текущий билд: " + data.currentBuild + " → Будет применен: " + data.nextBuild + " · Серверов: " + data.upstreamCount;

  const tbody = document.getElementById("diffBody");
  tbody.innerHTML = data.items.map(item => {
    let badgeClass = "badge-unchanged";
    let badgeText = '<svg style="width:12px;height:12px"><use href="#i-check"/></svg> Без изменений';
    if (item.status === "added") { badgeClass = "badge-added"; badgeText = '<svg style="width:12px;height:12px"><use href="#i-plus"/></svg> Новый'; }
    else if (item.status === "modified") { badgeClass = "badge-modified"; badgeText = '<svg style="width:12px;height:12px"><use href="#i-edit"/></svg> Изменен'; }
    else if (item.status === "removed") { badgeClass = "badge-removed"; badgeText = '<svg style="width:12px;height:12px"><use href="#i-trash"/></svg> Удален'; }

    const network = (item.params?.type || "tcp").toUpperCase();
    const security = (item.params?.security || "none").toUpperCase();

    return '<tr>' +
      '<td><span class="badge ' + badgeClass + '">' + badgeText + '</span></td>' +
      '<td style="font-weight: 600;">' + (item.formattedRemark || item.remark) + '</td>' +
      '<td style="font-family: monospace; color: var(--cyan);">' + item.address + '</td>' +
      '<td style="font-family: monospace;">' + item.port + '</td>' +
      '<td><span style="font-size: 11px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">' + (item.protocol || "vless").toUpperCase() + ' · ' + network + ' · ' + security + '</span></td>' +
      '<td style="color: var(--text-sub); font-size: 12px;">' + (item.changeDesc || "—") + '</td>' +
    '</tr>';
  }).join("");
}

async function applyChanges() {
  if (!lastResult) return;
  const btn = document.getElementById("btnApply");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> <span>Применяем и пушим...</span>';

  try {
    const resp = await fetch("/api/sync?action=apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txt: lastResult.previewTxt,
        json: lastResult.previewJson,
        build: lastResult.nextBuild
      })
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      showToast(data.error || "Ошибка применения", true);
      return;
    }

    showToast("🎉 Успешно! Подписка обновлена до Build-" + data.build + " и сохранена!");
    document.getElementById("applyBar").style.display = "none";
  } catch(e) {
    showToast("Ошибка применения: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg style="width:18px;height:18px"><use href="#i-rocket"/></svg> <span>Применить и обновить подписку (Build + 1)</span>';
  }
}
</script>
</body>
</html>
  `);
}

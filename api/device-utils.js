export function detectPlatform(ua) {
  const lower = (ua || "").toLowerCase();
  const happ = lower.match(/^happ\/[^/]+\/(ios|android|ipados|windows|macos|mac|linux)\//);
  if (happ) {
    if (happ[1] === "ios" || happ[1] === "android" || happ[1] === "ipados") return "mobile";
    return "desktop";
  }
  if (lower.includes("android") || lower.includes("iphone") || lower.includes("ipad") || lower.includes("ipod") || lower.includes("mobile")) return "mobile";
  if (lower.includes("/ios/") || lower.includes("/ipados/")) return "mobile";
  if (lower.includes("windows") || lower.includes("macintosh") || lower.includes("linux") || lower.includes("desktop")) return "desktop";
  return "unknown";
}

const OS_LABELS = {
  ios: "iOS",
  android: "Android",
  ipados: "iPadOS",
  windows: "Windows",
  macos: "macOS",
  mac: "macOS",
  linux: "Linux",
};

export function parseClient(ua) {
  if (!ua || ua === "unknown") {
    return { name: "Unknown", os: "", version: "", label: "Unknown" };
  }

  const happ = ua.match(/^Happ\/([^/]+)\/(ios|android|ipados|windows|macos|mac|linux)\//i);
  if (happ) {
    const os = OS_LABELS[happ[2].toLowerCase()] || happ[2];
    return { name: "Happ", os, version: happ[1], label: `Happ · ${os} · ${happ[1]}` };
  }

  const lower = ua.toLowerCase();
  if (lower.includes("v2rayng")) return { name: "v2rayNG", os: "Android", version: "", label: "v2rayNG · Android" };
  if (lower.includes("shadowrocket")) return { name: "Shadowrocket", os: "iOS", version: "", label: "Shadowrocket · iOS" };
  if (lower.includes("streisand")) return { name: "Streisand", os: "iOS", version: "", label: "Streisand · iOS" };
  if (lower.includes("hiddify")) return { name: "Hiddify", os: "", version: "", label: "Hiddify" };
  if (lower.includes("clash")) return { name: "Clash", os: "", version: "", label: "Clash" };
  if (lower.includes("v2rayn")) return { name: "v2rayN", os: "Windows", version: "", label: "v2rayN · Windows" };
  if (lower.includes("nekoray") || lower.includes("neko")) return { name: "NekoRay", os: "", version: "", label: "NekoRay" };

  if (lower.includes("iphone") || lower.includes("ipad") || lower.includes("ipod")) {
    return { name: "iOS", os: "iOS", version: "", label: "iOS client" };
  }
  if (lower.includes("android")) return { name: "Android", os: "Android", version: "", label: "Android client" };
  if (lower.includes("windows")) return { name: "Windows", os: "Windows", version: "", label: "Windows client" };
  if (lower.includes("macintosh") || lower.includes("mac os")) return { name: "macOS", os: "macOS", version: "", label: "macOS client" };

  const short = ua.length > 36 ? ua.slice(0, 36) + "…" : ua;
  return { name: "Other", os: "", version: "", label: short };
}

export function parseBuildFromSub(text) {
  const direct = text.match(/^#\s*(build-\S+)/im);
  if (direct) return direct[1].trim();
  const legacy = text.match(/^#\s*build[:\-]\s*(\S+)/im);
  if (legacy) return legacy[1].trim();
  const announce = text.match(/announce:.*?\|\s*(build-\S+)/i);
  if (announce) return announce[1].trim();
  return "unknown";
}

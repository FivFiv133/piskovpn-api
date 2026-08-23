/**
 * Generates Sing-box / Happ multi-node JSON configuration with all 35 individual servers
 */
export function generateSingBoxJsonConfig(subText) {
  const lines = (subText || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const nodeOutbounds = [];
  const tags = [];

  for (const line of lines) {
    if (line.startsWith("vless://")) {
      try {
        const url = new URL(line);
        const uuid = url.username;
        const host = url.hostname;
        const port = parseInt(url.port || "443", 10);
        const type = url.searchParams.get("type") || "tcp";
        const security = url.searchParams.get("security") || "none";
        const pbk = url.searchParams.get("pbk") || "";
        const fp = url.searchParams.get("fp") || "qq";
        const sni = url.searchParams.get("sni") || "";
        const sid = url.searchParams.get("sid") || "";
        const flow = url.searchParams.get("flow") || "";
        const path = url.searchParams.get("path") || "";
        const mode = url.searchParams.get("mode") || "";
        const extraStr = url.searchParams.get("extra") || "";
        let extra = null;
        if (extraStr) {
          try { extra = JSON.parse(extraStr); } catch {}
        }
        const tag = decodeURIComponent(url.hash.replace(/^#/, ""));
        if (!tag) continue;
        tags.push(tag);

        const outbound = {
          type: "vless",
          tag,
          server: host,
          server_port: port,
          uuid,
        };

        if (flow) {
          outbound.flow = flow;
        }

        if (security === "reality") {
          outbound.tls = {
            enabled: true,
            server_name: sni,
            utls: {
              enabled: true,
              fingerprint: fp,
            },
            reality: {
              enabled: true,
              public_key: pbk,
              short_id: sid,
            },
          };
        } else if (security === "tls") {
          outbound.tls = {
            enabled: true,
            server_name: sni,
            utls: {
              enabled: true,
              fingerprint: fp,
            },
          };
        }

        if (type === "xhttp") {
          outbound.transport = {
            type: "xhttp",
            path: path || "/poll",
            mode: mode || "packet-up",
          };
          if (extra?.headers) {
            outbound.transport.headers = extra.headers;
          }
        } else if (type === "grpc") {
          const serviceName = url.searchParams.get("serviceName") || "";
          outbound.transport = {
            type: "grpc",
            service_name: serviceName,
          };
        }

        nodeOutbounds.push(outbound);
      } catch {}
    } else if (line.startsWith("hysteria2://") || line.startsWith("hy2://")) {
      try {
        const url = new URL(line);
        const auth = url.username;
        const host = url.hostname;
        const port = parseInt(url.port || "443", 10);
        const sni = url.searchParams.get("sni") || host;
        const tag = decodeURIComponent(url.hash.replace(/^#/, ""));
        if (!tag) continue;
        tags.push(tag);

        nodeOutbounds.push({
          type: "hysteria2",
          tag,
          server: host,
          server_port: port,
          password: auth,
          tls: {
            enabled: true,
            server_name: sni,
            alpn: ["h3"],
          },
        });
      } catch {}
    }
  }

  return {
    version: 1,
    outbounds: [
      {
        type: "selector",
        tag: "select",
        outbounds: tags,
        default: tags[0] || "direct",
      },
      {
        type: "urltest",
        tag: "auto",
        outbounds: tags,
        url: "http://www.gstatic.com/generate_204",
        interval: "3m",
        tolerance: 50,
      },
      ...nodeOutbounds,
      {
        type: "direct",
        tag: "direct",
      },
      {
        type: "block",
        tag: "block",
      },
      {
        type: "dns",
        tag: "dns-out",
      },
    ],
  };
}


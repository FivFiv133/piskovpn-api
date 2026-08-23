/**
 * Generates full Xray JSON configuration for PiskoVPN
 * Features:
 * - Smart BLACK_BALANCER across foreign nodes (UK, DE, NL, EE, AL, CH, LT, AT, US, LV)
 * - Automatic Fallback on Russian Ingress node (ihc185.adrtun.ru:443 with api-maps.yandex.ru)
 * - Direct routing for Russian domestic traffic (geosite:category-ru, geoip:ru)
 * - Burst Observatory active health check (http://www.gstatic.com/generate_204)
 */
export function generatePiskoJsonConfig() {
  const UUID = "cd6bcc13-aec7-4ae0-b11e-8d4fdddd250c";
  const PBK = "1vSZjvhZO01oAEH3b7eebR1qF5dLU1Dq2E7xu8pwGSs";
  const SID = "428ef87fd47a3a32";

  return {
    burstObservatory: {
      pingConfig: {
        connectivity: "",
        destination: "http://www.gstatic.com/generate_204",
        interval: "120s",
        sampling: 1,
        timeout: "3s"
      },
      subjectSelector: [
        "black",
        "proxy"
      ]
    },
    dns: {
      queryStrategy: "IPIfNonMatch",
      servers: [
        {
          address: "1.1.1.1",
          skipFallback: false
        }
      ],
      tag: "dns_out"
    },
    inbounds: [
      {
        listen: "127.0.0.1",
        port: 10808,
        protocol: "socks",
        settings: {
          auth: "noauth",
          udp: true,
          userLevel: 8
        },
        sniffing: {
          destOverride: [
            "http",
            "tls",
            "fakedns"
          ],
          enabled: true
        },
        tag: "socks"
      },
      {
        listen: "127.0.0.1",
        port: 10809,
        protocol: "http",
        settings: {
          allowTransparent: false,
          userLevel: 8
        },
        sniffing: {
          destOverride: [
            "http",
            "tls",
            "fakedns"
          ],
          enabled: true
        },
        tag: "http"
      },
      {
        listen: "127.0.0.1",
        port: 10901,
        protocol: "dokodemo-door",
        settings: {
          address: "127.0.0.1",
          network: "tcp,udp"
        },
        tag: "loopback-entry"
      },
      {
        listen: "127.0.0.1",
        port: 10902,
        protocol: "dokodemo-door",
        settings: {
          address: "127.0.0.1",
          network: "tcp,udp"
        },
        tag: "loopback-fallback"
      }
    ],
    remarks: "💎 PiskoVPN · Auto Smart Hybrid",
    outbounds: [
      // 1. Working Ingress RU Node (Fallback on LTE)
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "ihc185.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "api-maps.yandex.ru",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "proxy"
      },
      // 2. Foreign Outbounds Pool for BLACK_BALANCER
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "osuk.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "rowing.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black"
      },
      {
        protocol: "hysteria",
        settings: {
          address: "dedde3.adrtun.ru",
          port: 443,
          version: 2
        },
        streamSettings: {
          finalmask: {
            quicParams: {
              congestion: "bbr",
              debug: false
            }
          },
          hysteriaSettings: {
            auth: UUID,
            version: 2
          },
          network: "hysteria",
          security: "tls",
          tlsSettings: {
            alpn: ["h3"],
            fingerprint: "qq",
            serverName: "dedde3.adrtun.ru"
          }
        },
        tag: "black-2"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "dedde3.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "moy.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-3"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "novonl.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "skupix.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-4"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "nee.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "alti.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-5"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "al.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "promocode.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-6"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "prvtch.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "mlx.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-7"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "redlt.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "iui.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-8"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "nat.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "downdetector.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-9"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "netus.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "vladmotors.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-10"
      },
      {
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: "mlr.adrtun.ru",
              port: 443,
              users: [
                {
                  encryption: "none",
                  flow: "xtls-rprx-vision",
                  id: UUID
                }
              ]
            }
          ]
        },
        streamSettings: {
          network: "tcp",
          realitySettings: {
            fingerprint: "qq",
            publicKey: PBK,
            serverName: "odnako.su",
            shortId: SID,
            spiderX: "/"
          },
          security: "reality",
          tcpSettings: {}
        },
        tag: "black-11"
      },
      // 3. Freedom / Direct
      {
        protocol: "freedom",
        tag: "direct"
      },
      // 4. Block
      {
        protocol: "blackhole",
        tag: "block"
      },
      // 5. Loopbacks
      {
        protocol: "loopback",
        settings: {
          inboundTag: "loopback-entry"
        },
        tag: "loopback-entry-out"
      },
      {
        protocol: "loopback",
        settings: {
          inboundTag: "loopback-fallback"
        },
        tag: "loopback-fallback-out"
      }
    ],
    routing: {
      balancers: [
        {
          fallbackTag: "loopback-fallback-out",
          selector: ["black"],
          strategy: {
            settings: {
              baselines: ["200ms", "400ms"],
              expected: 1,
              maxRTT: "800ms",
              tolerance: 0.1
            },
            type: "leastLoad"
          },
          tag: "BLACK_BALANCER"
        }
      ],
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          inboundTag: ["socks", "http"],
          outboundTag: "loopback-entry-out",
          type: "field"
        },
        {
          inboundTag: ["loopback-fallback"],
          outboundTag: "proxy",
          type: "field"
        },
        {
          domain: [
            "localhost",
            "localhost.localdomain",
            "local",
            "*.local",
            "*.localdomain",
            "*.lan",
            "*.internal"
          ],
          inboundTag: ["loopback-entry"],
          outboundTag: "direct",
          type: "field"
        },
        {
          inboundTag: ["loopback-entry"],
          ip: [
            "127.0.0.0/8",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
            "::1/128",
            "fc00::/7",
            "fe80::/10"
          ],
          outboundTag: "direct",
          type: "field"
        },
        {
          inboundTag: ["loopback-entry"],
          ip: [
            "173.245.48.0/20",
            "103.21.244.0/22",
            "103.22.200.0/22",
            "103.31.4.0/22",
            "141.101.64.0/18",
            "108.162.192.0/18",
            "190.93.240.0/20",
            "188.114.96.0/20",
            "197.234.240.0/22",
            "198.41.128.0/17",
            "162.158.0.0/15",
            "104.16.0.0/13",
            "104.24.0.0/14",
            "172.64.0.0/13",
            "131.0.72.0/22",
            "2400:cb00::/32",
            "2606:4700::/32",
            "2803:f800::/32",
            "2405:b500::/32",
            "2405:8100::/32",
            "2a06:98c0::/29",
            "2c0f:f248::/32"
          ],
          outboundTag: "BLACK_BALANCER",
          type: "field"
        },
        {
          inboundTag: ["loopback-entry"],
          outboundTag: "BLACK_BALANCER",
          protocol: ["bittorrent"],
          type: "field"
        },
        {
          domain: [
            "domain:2ip.ru",
            "domain:2ip.io",
            "habr.com",
            "4pda.to",
            "4pda.ru",
            "kemono.su",
            "jut.su",
            "kara.su",
            "theins.ru",
            "tvrain.ru",
            "echo.msk.ru",
            "the-village.ru",
            "snob.ru",
            "novayagazeta.ru",
            "moscowtimes.ru"
          ],
          inboundTag: ["loopback-entry"],
          outboundTag: "BLACK_BALANCER",
          type: "field"
        },
        {
          domain: [
            "geosite:private",
            "geosite:category-ru"
          ],
          inboundTag: ["loopback-entry"],
          outboundTag: "direct",
          type: "field"
        },
        {
          inboundTag: ["loopback-entry"],
          ip: [
            "geoip:ru",
            "geoip:private"
          ],
          outboundTag: "direct",
          type: "field"
        },
        {
          inboundTag: ["loopback-entry"],
          network: "tcp,udp",
          outboundTag: "BLACK_BALANCER",
          type: "field"
        }
      ]
    }
  };
}

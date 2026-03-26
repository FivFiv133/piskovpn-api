const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/FivFiv133/PiskoVPN/refs/heads/main/PiskoVPN.txt";

export default async function handler(req, res) {
  try {
    const response = await fetch(GITHUB_RAW_URL, {
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return res.status(502).send("Failed to fetch subscription");
    }

    const body = await response.text();

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="PiskoVPN"');
    res.setHeader("new-url", "https://piskovpn-api.vercel.app/sub");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.status(200).send(body);
  } catch (err) {
    res.status(500).send("Internal server error");
  }
}

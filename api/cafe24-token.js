const https = require("https");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { grant_type, code, refresh_token } = req.body;
  const CLIENT_ID     = process.env.CAFE24_CLIENT_ID;
  const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
  const MALL_ID       = process.env.CAFE24_MALL_ID;
  const REDIRECT_URI  = "https://ozkizny-ui.github.io/ozkiz-ad-studio/callback";

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  let body;
  if (grant_type === "authorization_code") {
    body = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  } else if (grant_type === "refresh_token") {
    body = `grant_type=refresh_token&refresh_token=${refresh_token}`;
  } else {
    return res.status(400).json({ error: "Invalid grant_type" });
  }

  try {
    const response = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

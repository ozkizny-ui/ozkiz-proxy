export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, token } = req.query;
  if (!path || !token) return res.status(400).json({ error: "path and token required" });

  const MALL_ID = process.env.CAFE24_MALL_ID;
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/${path}`;

  // query string 재구성 (path, token 제외)
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "path" && k !== "token") params.append(k, v);
  }
  const fullUrl = params.toString() ? `${url}?${params}` : url;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (req.method !== "GET" && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const response = await fetch(fullUrl, fetchOpts);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

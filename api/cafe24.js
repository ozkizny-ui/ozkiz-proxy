export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });

  const MALL_ID  = process.env.CAFE24_MALL_ID;
  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  // Redis에서 Access Token 가져오기
  const r = await fetch(`${KV_URL}/get/cafe24_access_token`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await r.json();
  const token = data.result;

  if (!token) return res.status(401).json({ error: '카페24 인증이 필요합니다.' });

  const url = `https://${MALL_ID}.cafe24api.com/api/v2/${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') params.append(k, v);
  }
  const fullUrl = params.toString() ? `${url}?${params}` : url;

  try {
    const fetchOpts = {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.body) fetchOpts.body = JSON.stringify(req.body);
    const response = await fetch(fullUrl, fetchOpts);
    const result = await response.json();
    return res.status(response.status).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

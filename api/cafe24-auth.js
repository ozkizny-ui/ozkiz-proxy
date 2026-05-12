export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const CLIENT_ID    = process.env.CAFE24_CLIENT_ID;
  const MALL_ID      = process.env.CAFE24_MALL_ID;
  const REDIRECT_URI = 'https://ozkiz-proxy.vercel.app/api/cafe24-callback';
  const KV_URL       = process.env.KV_REST_API_URL;
  const KV_TOKEN     = process.env.KV_REST_API_TOKEN;

  const { action } = req.query;

  // 현재 인증 상태 확인
  if (action === 'status') {
    try {
      const r = await fetch(`${KV_URL}/get/cafe24_access_token`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const data = await r.json();
      return res.status(200).json({ authenticated: !!data.result });
    } catch (e) {
      return res.status(200).json({ authenticated: false });
    }
  }

  // 인증 URL 반환
  if (action === 'url') {
    const authUrl = `https://${MALL_ID}.cafe24api.com/api/v2/oauth/authorize`
      + `?response_type=code`
      + `&client_id=${CLIENT_ID}`
      + `&state=ozkiz_ad`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&scope=mall.read_product,mall.read_community,mall.read_store`;
    return res.status(200).json({ url: authUrl });
  }

  // 토큰 갱신
  if (action === 'refresh') {
    try {
      const rtRes = await fetch(`${KV_URL}/get/cafe24_refresh_token`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const rtData = await rtRes.json();
      if (!rtData.result) return res.status(401).json({ error: '로그인이 필요합니다.' });

      const credentials = Buffer.from(`${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`).toString('base64');
      const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=refresh_token&refresh_token=${rtData.result}`,
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error) return res.status(401).json({ error: tokenData.error_description });

      await fetch(`${KV_URL}/set/cafe24_access_token/${encodeURIComponent(tokenData.access_token)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      await fetch(`${KV_URL}/expire/cafe24_access_token/7200`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}

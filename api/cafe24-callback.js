export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`https://ozkizny-ui.github.io/ozkiz-ad-studio/?auth=error&msg=${error}`);
  }
  if (!code) {
    return res.status(400).send('인증 코드가 없습니다.');
  }

  const CLIENT_ID     = process.env.CAFE24_CLIENT_ID;
  const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
  const MALL_ID       = process.env.CAFE24_MALL_ID;
  const REDIRECT_URI  = 'https://ozkiz-proxy.vercel.app/api/cafe24-callback';

  try {
    // Access Token 발급
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      return res.redirect(`https://ozkizny-ui.github.io/ozkiz-ad-studio/?auth=error&msg=${tokenData.error_description}`);
    }

    // Redis에 토큰 저장 (KV_REST_API 사용)
    const KV_URL   = process.env.KV_REST_API_URL;
    const KV_TOKEN = process.env.KV_REST_API_TOKEN;

    await fetch(`${KV_URL}/set/cafe24_access_token/${encodeURIComponent(tokenData.access_token)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    await fetch(`${KV_URL}/set/cafe24_refresh_token/${encodeURIComponent(tokenData.refresh_token)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    // Access Token 만료 시간 설정 (2시간)
    await fetch(`${KV_URL}/expire/cafe24_access_token/7200`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });

    // 인증 성공 → 앱으로 리다이렉트
    return res.redirect(`https://ozkizny-ui.github.io/ozkiz-ad-studio/?auth=success`);
  } catch (e) {
    return res.redirect(`https://ozkizny-ui.github.io/ozkiz-ad-studio/?auth=error&msg=${e.message}`);
  }
}

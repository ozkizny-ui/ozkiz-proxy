export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MALL_ID  = process.env.CAFE24_MALL_ID;
  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  // Redis에서 Access Token 가져오기
  const getToken = async () => {
    const r = await fetch(`${KV_URL}/get/cafe24_access_token`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await r.json();
    return data.result;
  };

  try {
    let token = await getToken();
    if (!token) return res.status(401).json({ error: '카페24 인증이 필요합니다.' });

    // 예약판매 상품 조회 (sold_out_type이 P인 상품)
    const presaleNames = new Set();
    let offset = 0;
    const limit = 100;

    while (true) {
      const r = await fetch(
        `https://${MALL_ID}.cafe24api.com/api/v2/admin/products?limit=${limit}&offset=${offset}` +
        `&sold_out_type=P`,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      const data = await r.json();

      if (data.error) {
        // 토큰 만료 시 401
        return res.status(401).json({ error: '토큰이 만료됐습니다. 재인증이 필요합니다.' });
      }

      const products = data.products || [];
      products.forEach(p => presaleNames.add(p.product_name));
      if (products.length < limit) break;
      offset += limit;
    }

    return res.status(200).json({
      presale_products: [...presaleNames],
      count: presaleNames.size,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

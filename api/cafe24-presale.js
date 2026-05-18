export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MALL_ID  = process.env.CAFE24_MALL_ID;
  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  const PRESALE_KEYWORD = '순차출고';

  try {
    const r = await fetch(`${KV_URL}/get/cafe24_access_token`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await r.json();
    const token = data.result;
    if (!token) return res.status(401).json({ error: '카페24 인증이 필요합니다.' });

    // 전체 상품 목록 수집 (product_no + product_name)
    const allProducts = []; // { product_no, product_name }
    const presaleProductNos = new Set();
    let offset = 0;
    const limit = 100;

    while (true) {
      const r2 = await fetch(
        `https://${MALL_ID}.cafe24api.com/api/v2/admin/products` +
        `?limit=${limit}&offset=${offset}&fields=product_no,product_name,options`,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      const d2 = await r2.json();

      if (d2.error) {
        return res.status(401).json({ error: d2.error.message || '토큰 오류' });
      }

      const products = d2.products || [];

      products.forEach(p => {
        const nameMatch = (p.product_name || '').includes(PRESALE_KEYWORD);
        let optionMatch = false;
        if (p.options && Array.isArray(p.options)) {
          optionMatch = p.options.some(opt =>
            (opt.option_name || '').includes(PRESALE_KEYWORD) ||
            (opt.option_value || []).some(v =>
              (v.option_text || '').includes(PRESALE_KEYWORD)
            )
          );
        }

        // 전체 상품 목록 저장 (매칭용)
        allProducts.push({
          product_no: String(p.product_no),
          product_name: p.product_name || '',
        });

        if (nameMatch || optionMatch) {
          presaleProductNos.add(String(p.product_no));
        }
      });

      if (products.length < limit) break;
      offset += limit;
    }

    return res.status(200).json({
      presale_product_nos: [...presaleProductNos],
      all_products: allProducts, // 전체 상품 목록 (이지어드민 매칭용)
      count: presaleProductNos.size,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

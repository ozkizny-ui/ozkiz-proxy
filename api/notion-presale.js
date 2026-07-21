export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
  const NOTION_DB_ID = '5d2ae3562c064494b6b1f0fc6469aa8a';

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_API_TOKEN not configured' });
  }

  try {
    const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    const items = [];
    let cursor = undefined;

    // 노션 DB 전체 페이지 수집 (페이지네이션)
    while (true) {
      const body = {
        filter: {
          property: '입고일',
          date: { on_or_after: today },
        },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;

      const r = await fetch(
        `https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

      if (!r.ok) {
        const err = await r.json();
        return res.status(r.status).json({ error: err.message || '노션 API 오류' });
      }

      const data = await r.json();

      for (const page of data.results) {
        const props = page.properties;
        // 상품명: 페이지 title 속성
        const titleProp = props['제품명'] || props['이름'] || props['Name'] ||
          Object.values(props).find(p => p.type === 'title');
        const name = titleProp?.title?.[0]?.plain_text?.trim() || '';

        // 입고일
        const arrivalDate = props['입고일']?.date?.start || null;

        // 진행상태 (optional — 추가 참고용)
        const statusProp = props['진행상태'];
        const status = statusProp?.status?.name || statusProp?.select?.name || '';

        if (!name) continue;

        // 입고예정 표용 확장 필드 (기존 소비자는 name/arrivalDate/status만 사용 — 하위호환)
        const season = (props['시즌']?.multi_select || []).map(s => s.name).join(', ');
        const kinds  = (props['제품유형']?.multi_select || []).map(s => s.name).join(', ');
        const qtyRoll = props['발주수량 합계']?.rollup;
        const qty = (qtyRoll && qtyRoll.type === 'number' ? qtyRoll.number : null) ?? props['입고수량']?.number ?? null;
        const category = props['복종']?.select?.name || '';
        const brand    = props['브랜드']?.select?.name || '';

        items.push({ name, arrivalDate, status, season, kinds, qty, category, brand });
      }

      if (!data.has_more) break;
      cursor = data.next_cursor;
    }

    // 입고일 기준 분류
    const presale = items.filter(i => i.arrivalDate && i.arrivalDate >= today);
    const past    = items.filter(i => i.arrivalDate && i.arrivalDate < today);

    return res.status(200).json({
      // 프론트에서 사용하는 핵심 데이터
      // [{name, arrivalDate, status}] — 입고일이 오늘 이후인 것만
      items: presale,
      // 디버그용
      past_count: past.length,
      total_count: items.length,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

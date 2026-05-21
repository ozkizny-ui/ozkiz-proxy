export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_API_TOKEN;
  const NOTION_DB_ID = 'c64f69e141c54909958acfee8f6606f3';

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
          date: { is_not_empty: true },
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
        // 상품명: 페이지 title 속성
        const titleProp = page.properties['이름'] || page.properties['Name'] ||
          Object.values(page.properties).find(p => p.type === 'title');
        const name = titleProp?.title?.[0]?.plain_text?.trim() || '';

        // 입고일
        const arrivalDate = page.properties['입고일']?.date?.start || null;

        // 진행상태 (optional — 추가 참고용)
        const statusProp = page.properties['진행상태'];
        const status = statusProp?.status?.name || statusProp?.select?.name || '';

        if (!name) continue;

        items.push({ name, arrivalDate, status });
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

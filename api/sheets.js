export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SHEETS_KEY     = process.env.GOOGLE_SHEETS_API_KEY;
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_PA_URL;
  const SHEET_ID       = "1UGYRA8IAb_8jzhR41qXmGrAxruL7QJBnlkgWjqRgSPA";
  const SHEET_NAME     = "광고";
  const BASE           = "https://sheets.googleapis.com/v4/spreadsheets";

  const { action } = req.query;

  const ROUNDS = [
    { product: 8,  reels: 9,  check: 10, ad_name: 15 },
    { product: 16, reels: 17, check: 18, ad_name: 23 },
    { product: 24, reels: 25, check: 26, ad_name: 31 },
    { product: 32, reels: 33, check: 34, ad_name: 39 },
    { product: 40, reels: 41, check: 42, ad_name: 47 },
    { product: 48, reels: 49, check: 50, ad_name: 55 },
    { product: 56, reels: 57, check: 58, ad_name: 62 },
    { product: 64, reels: 65, check: 66, ad_name: 70 },
  ];

  function colLetter(idx) {
    let s = "";
    idx += 1;
    while (idx > 0) {
      idx--;
      s = String.fromCharCode(65 + (idx % 26)) + s;
      idx = Math.floor(idx / 26);
    }
    return s;
  }

  try {

    // ── PA 데이터 전체 조회 ───────────────────────────────────────
    if (action === "get_pa_data") {
      if (!SHEETS_KEY) return res.status(500).json({ error: "GOOGLE_SHEETS_API_KEY not configured" });

      const range = `${SHEET_NAME}!A1:BT200`;
      const r = await fetch(
        `${BASE}/${SHEET_ID}/values/${encodeURIComponent(range)}?key=${SHEETS_KEY}`
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });

      const rows = data.values || [];
      const results = [];

      for (let rowIdx = 3; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || !row[2]) continue;

        const instaId = String(row[2] || "").trim();

        for (let ri = 0; ri < ROUNDS.length; ri++) {
          const round = ROUNDS[ri];
          const product  = String(row[round.product] || "").trim();
          const reelsUrl = String(row[round.reels]   || "").trim();
          const checked  = String(row[round.check]   || "").trim();
          const adName   = String(row[round.ad_name] || "").trim();

          if (!reelsUrl || !reelsUrl.startsWith("http")) continue;
          if (!product) continue;

          results.push({
            row_index: rowIdx + 1,
            round: ri + 1,
            insta_id: instaId,
            product,
            reels_url: reelsUrl,
            ad_name: adName,
            checked: checked === "TRUE" || checked === "true" || checked === "1",
            check_col: colLetter(round.check),
          });
        }
      }

      return res.status(200).json({ pa_data: results });
    }

    // ── 광고세팅 체크 업데이트 (Apps Script 경유) ─────────────────
    if (action === "check_pa") {
      if (!APPS_SCRIPT_URL) return res.status(500).json({ error: "APPS_SCRIPT_PA_URL not configured" });

      const { row_index, check_col } = req.body;
      if (!row_index || !check_col) return res.status(400).json({ error: "row_index, check_col required" });

      const r = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_index, check_col }),
      });

      const text = await r.text();
      try {
        const data = JSON.parse(text);
        if (data.success) return res.status(200).json({ success: true });
        return res.status(400).json({ error: data.error || "Apps Script 오류" });
      } catch(e) {
        return res.status(200).json({ success: true }); // Apps Script redirect 응답 처리
      }
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

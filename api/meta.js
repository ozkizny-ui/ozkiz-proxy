export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const META_TOKEN   = process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT   = process.env.META_AD_ACCOUNT_ID;
  const META_BASE    = "https://graph.facebook.com/v21.0";

  if (!META_TOKEN) return res.status(500).json({ error: "META_ACCESS_TOKEN not configured" });

  const { action } = req.query;

  try {
    // 광고 목록 + 인사이트 조회
    if (action === "get_ads") {
      const { hours = 4 } = req.query;
      const now   = new Date();
      const since = new Date(now - hours * 3600 * 1000).toISOString().split("T")[0];
      const until = now.toISOString().split("T")[0];

      const r = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}` +
        `&fields=id,name,status,daily_budget,insights.time_range({"since":"${since}","until":"${until}"})` +
        `{spend,purchase_roas,impressions}&limit=200`
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json(data);
    }

    // 예산 변경
    if (action === "update_budget") {
      const { ad_id, daily_budget } = req.body;
      if (!ad_id || !daily_budget) return res.status(400).json({ error: "ad_id and daily_budget required" });
      const r = await fetch(`${META_BASE}/${ad_id}?access_token=${META_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_budget: parseInt(daily_budget) }),
      });
      return res.status(200).json(await r.json());
    }

    // 광고 ON/OFF
    if (action === "toggle_ad") {
      const { ad_id, status } = req.body;
      if (!ad_id || !status) return res.status(400).json({ error: "ad_id and status required" });
      const r = await fetch(`${META_BASE}/${ad_id}?access_token=${META_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      return res.status(200).json(await r.json());
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

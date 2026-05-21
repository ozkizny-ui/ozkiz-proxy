export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const META_TOKEN = process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  const CATALOG_ID = process.env.META_CATALOG_ID;
  const PIXEL_ID   = process.env.META_PIXEL_ID;
  const PAGE_ID    = process.env.META_PAGE_ID;
  const META_BASE  = "https://graph.facebook.com/v21.0";

  if (!META_TOKEN) return res.status(500).json({ error: "META_ACCESS_TOKEN not configured" });

  const { action } = req.query;

  try {

    // ── 기존: 광고 목록 조회 ──────────────────────────────────────
    if (action === "get_ads") {
      const now   = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const today = kstNow.toISOString().split("T")[0]; // KST 기준 오늘
      const fields = [
        "id", "name", "status", "effective_status", "daily_budget",
        `insights.time_range({"since":"${today}","until":"${today}"})` +
        `{spend,purchase_roas,impressions,actions,action_values}`
      ].join(",");
      const r = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}` +
        `&fields=${encodeURIComponent(fields)}&limit=200`
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json(data);
    }

    // ── 기존: 예산 변경 ───────────────────────────────────────────
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

    // ── 기존: 광고 ON/OFF ─────────────────────────────────────────
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

    // ── 신규: 캠페인 목록 조회 ────────────────────────────────────
    if (action === "get_campaigns") {
      const r = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/campaigns?access_token=${META_TOKEN}` +
        `&fields=id,name,status,objective&limit=50`
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ campaigns: data.data || [] });
    }

    // ── 신규: 제품 세트 목록 조회 (컬렉션용) ─────────────────────
    if (action === "get_product_sets") {
      if (!CATALOG_ID) return res.status(500).json({ error: "META_CATALOG_ID not configured" });
      const r = await fetch(
        `${META_BASE}/${CATALOG_ID}/product_sets?access_token=${META_TOKEN}` +
        `&fields=id,name,filter,product_count&limit=50`
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ product_sets: data.data || [] });
    }

    // ── 신규: 이미지 업로드 ───────────────────────────────────────
    if (action === "upload_image") {
      const { image_base64, filename } = req.body;
      if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
      const r = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/adimages?access_token=${META_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bytes: image_base64, name: filename || "image.jpg" }),
        }
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      // 해시 반환
      const images = data.images || {};
      const hash = Object.values(images)[0]?.hash;
      return res.status(200).json({ hash });
    }

    // ── 신규: 영상 업로드 ─────────────────────────────────────────
    if (action === "upload_video") {
      const { video_base64, filename } = req.body;
      if (!video_base64) return res.status(400).json({ error: "video_base64 required" });
      const r = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/advideos?access_token=${META_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: video_base64,
            name: filename || "video.mp4",
            unpublished_content_type: "ADS_POST",
          }),
        }
      );
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ video_id: data.id });
    }

    // ── 신규: 광고 생성 (PAUSED) ──────────────────────────────────
    if (action === "create_ad") {
      const body = req.body;
      const {
        ad_type,        // IMAGE | VIDEO | COLLECTION | PA
        campaign_id,
        ad_name,        // 광고명 = 광고세트명
        landing_url,
        caption,
        // 이미지
        image_hash,
        // 영상
        video_id,
        // 컬렉션
        product_set_id,
        collection_label,
        // PA
        post_url,
      } = body;

      if (!campaign_id || !ad_name) {
        return res.status(400).json({ error: "campaign_id, ad_name required" });
      }

      const UTM = `utm_source=facebook&utm_medium=display&utm_campaign=ozkizmall&utm_content={{ad.name}}`;
      const trackingSpec = [
        { action_type: ["offsite_conversion"], fb_pixel: [PIXEL_ID] }
      ];

      // 1) 광고 세트 생성
      const adSetBody = {
        name: ad_name,
        campaign_id,
        status: "PAUSED",
        billing_event: "IMPRESSIONS",
        optimization_goal: "VALUE",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        daily_budget: 10000,
        destination_type: "WEBSITE",
        promoted_object: {
          pixel_id: PIXEL_ID,
          custom_event_type: "PURCHASE",
        },
        attribution_spec: [
          { event_type: "CLICK_THROUGH", window_days: 1 },
        ],
        targeting: {
          geo_locations: { countries: ["KR"] },
          locales: [23], // 한국어
        },
      };

      const adSetRes = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/adsets?access_token=${META_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(adSetBody),
        }
      );
      const adSetData = await adSetRes.json();
      if (adSetData.error) return res.status(400).json({ error: `광고세트 생성 실패: ${adSetData.error.message}` });
      const adset_id = adSetData.id;

      // 2) 크리에이티브 생성
      let creativeBody = { name: ad_name };
      const urlWithUtm = `${landing_url}${landing_url.includes("?") ? "&" : "?"}${UTM}`;

      if (ad_type === "IMAGE" && image_hash) {
        creativeBody.object_story_spec = {
          page_id: PAGE_ID,
          link_data: {
            image_hash,
            link: urlWithUtm,
            message: caption,
            call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } },
          },
        };
      } else if (ad_type === "VIDEO" && video_id) {
        creativeBody.object_story_spec = {
          page_id: PAGE_ID,
          video_data: {
            video_id,
            call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } },
            message: caption,
          },
        };
      } else if (ad_type === "COLLECTION" && product_set_id) {
        creativeBody.object_story_spec = {
          page_id: PAGE_ID,
          link_data: {
            link: urlWithUtm,
            message: caption,
            call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } },
            child_attachments: [],
          },
        };
        creativeBody.product_set_id = product_set_id;
        if (collection_label) creativeBody.label = collection_label;
      } else if (ad_type === "PA" && post_url) {
        // 파트너십 광고: 기존 게시물 사용
        creativeBody.object_story_spec = {
          page_id: PAGE_ID,
          link_data: {
            link: urlWithUtm,
            message: caption || "",
            call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } },
          },
        };
        creativeBody.instagram_permalink_url = post_url;
        creativeBody.enable_direct_install = false;
      } else {
        // 크리에이티브 없이 세트만 생성된 경우
        return res.status(200).json({
          adset_id,
          ad_id: null,
          warning: "소재 미업로드 - 광고세트만 생성됨. 메타 광고관리자에서 소재를 직접 추가해주세요.",
        });
      }

      const creativeRes = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/adcreatives?access_token=${META_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(creativeBody),
        }
      );
      const creativeData = await creativeRes.json();
      if (creativeData.error) return res.status(400).json({ error: `크리에이티브 생성 실패: ${creativeData.error.message}` });
      const creative_id = creativeData.id;

      // 3) 광고 생성
      const adRes = await fetch(
        `${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: ad_name,
            adset_id,
            creative: { creative_id },
            status: "PAUSED",
            tracking_specs: trackingSpec,
          }),
        }
      );
      const adData = await adRes.json();
      if (adData.error) return res.status(400).json({ error: `광고 생성 실패: ${adData.error.message}` });

      return res.status(200).json({
        success: true,
        adset_id,
        creative_id,
        ad_id: adData.id,
      });
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

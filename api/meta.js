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

  // Meta 그래프 에러를 진단 가능한 한 줄로 펼침 (message만으론 "Invalid parameter"라 원인 불명)
  const fbErr = (err) => {
    if (!err) return "unknown error";
    const parts = [err.message || "error"];
    if (err.error_user_title) parts.push(`[${err.error_user_title}]`);
    if (err.error_user_msg)   parts.push(err.error_user_msg);
    const blame = err.error_data && err.error_data.blame_field_specs;
    if (blame) parts.push(`field=${JSON.stringify(blame)}`);
    const tail = [];
    if (err.code != null)         tail.push(`code ${err.code}`);
    if (err.error_subcode != null) tail.push(`subcode ${err.error_subcode}`);
    if (err.fbtrace_id)           tail.push(`fbtrace ${err.fbtrace_id}`);
    if (tail.length) parts.push(`(${tail.join(", ")})`);
    return parts.join(" ");
  };

  const { action } = req.query;

  try {

    // ── [임시 진단 · 검증 후 제거] PA 릴스 URL → IG media id 해석 경로 탐색 ──
    if (action === "pa_resolve_test") {
      const reels_url = req.query.url || (req.body && req.body.url) || "";
      const out = { reels_url, steps: {} };

      // 1) shortcode 추출
      const m = reels_url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
      const shortcode = m ? m[1] : null;
      out.shortcode = shortcode;

      // 2) shortcode → media pk 디코드 (IG base64 alphabet)
      if (shortcode) {
        try {
          const AB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
          let id = 0n;
          for (const ch of shortcode) {
            const v = AB.indexOf(ch);
            if (v < 0) { id = null; break; }
            id = id * 64n + BigInt(v);
          }
          out.decoded_media_pk = id != null ? id.toString() : null;
        } catch (e) { out.decoded_error = e.message; }
      }

      // 3) instagram_oembed 시도 (oEmbed Read 기능 필요할 수 있음)
      try {
        const r = await fetch(`${META_BASE}/instagram_oembed?url=${encodeURIComponent(reels_url)}&access_token=${META_TOKEN}`);
        out.steps.oembed = await r.json();
      } catch (e) { out.steps.oembed = { fetch_error: e.message }; }

      // 4) PAGE에 연결된 IG 비즈니스 계정 조회
      try {
        const r = await fetch(`${META_BASE}/${PAGE_ID}?fields=instagram_business_account,connected_instagram_account&access_token=${META_TOKEN}`);
        out.steps.page_ig = await r.json();
      } catch (e) { out.steps.page_ig = { fetch_error: e.message }; }

      // 5) 디코드한 pk를 media 노드로 직접 조회
      if (out.decoded_media_pk) {
        try {
          const r = await fetch(`${META_BASE}/${out.decoded_media_pk}?fields=id,media_type,owner,username,permalink,shortcode&access_token=${META_TOKEN}`);
          out.steps.media_node = await r.json();
        } catch (e) { out.steps.media_node = { fetch_error: e.message }; }
      }

      // 6) 광고계정에 연결된 (광고주) IG 계정 조회 → instagram_user_id 후보
      try {
        const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/instagram_accounts?fields=id,username&access_token=${META_TOKEN}`);
        out.steps.act_ig_accounts = await r.json();
      } catch (e) { out.steps.act_ig_accounts = { fetch_error: e.message }; }
      // 페이지 통한 IG 계정(page_backed) 후보도
      try {
        const r = await fetch(`${META_BASE}/${AD_ACCOUNT}?fields=name,currency&access_token=${META_TOKEN}`);
        out.steps.act_info = await r.json();
      } catch (e) { out.steps.act_info = { fetch_error: e.message }; }

      // 6.5) IG 읽기/파트너십 능력 진단
      const brandIg = req.query.ig_user_id || (out.steps.act_ig_accounts?.data?.[0]?.id) || null;
      out.brand_ig = brandIg;
      if (brandIg) {
        // 토큰이 브랜드 자체 미디어를 읽을 수 있는지 (IG read 능력 sanity)
        try {
          const r = await fetch(`${META_BASE}/${brandIg}/media?fields=id,shortcode,permalink&limit=2&access_token=${META_TOKEN}`);
          out.steps.brand_media = await r.json();
        } catch (e) { out.steps.brand_media = { fetch_error: e.message }; }
        // 브랜디드 콘텐츠 광고 권한 목록
        try {
          const r = await fetch(`${META_BASE}/${brandIg}/branded_content_ad_permissions?access_token=${META_TOKEN}`);
          out.steps.bc_ad_permissions = await r.json();
        } catch (e) { out.steps.bc_ad_permissions = { fetch_error: e.message }; }
      }
      // V2 형식 추정 {pk}_{brandIg} 노드 조회
      if (out.decoded_media_pk && brandIg) {
        try {
          const guess = `${out.decoded_media_pk}_${brandIg}`;
          const r = await fetch(`${META_BASE}/${guess}?fields=id,media_type,permalink&access_token=${META_TOKEN}`);
          out.steps.v2_guess = { id_tried: guess, resp: await r.json() };
        } catch (e) { out.steps.v2_guess = { fetch_error: e.message }; }
      }

      // 7) (create=1일 때만) source_instagram_media_id로 adcreative 생성 시도 — 여러 페이로드 형태
      if ((req.query.create === "1") && out.decoded_media_pk) {
        const igUser = req.query.ig_user_id ||
          (out.steps.act_ig_accounts?.data?.[0]?.id) || null;
        out.ig_user_id_used = igUser;
        const pk = out.decoded_media_pk;
        const attempts = {
          A_source_only:        { name: "PA_spike_A", source_instagram_media_id: pk },
          B_source_iguser:      { name: "PA_spike_B", source_instagram_media_id: pk, instagram_user_id: igUser },
          C_oss_iguser_source:  { name: "PA_spike_C", object_story_spec: { page_id: PAGE_ID, instagram_user_id: igUser }, source_instagram_media_id: pk },
        };
        out.creative_attempts = {};
        for (const [k, payload] of Object.entries(attempts)) {
          try {
            const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/adcreatives?access_token=${META_TOKEN}`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
            });
            out.creative_attempts[k] = await r.json();
          } catch (e) { out.creative_attempts[k] = { fetch_error: e.message }; }
        }
      }

      return res.status(200).json(out);
    }

    // ── [임시 · 검증 후 제거] 스파이크 고아 객체 정리 (이름에 SPIKE 포함 adset 삭제) ──
    if (action === "spike_cleanup") {
      const lr = await fetch(`${META_BASE}/${AD_ACCOUNT}/adsets?fields=id,name,created_time&limit=200&access_token=${META_TOKEN}`);
      const ld = await lr.json();
      if (ld.error) return res.status(400).json({ error: ld.error.message });
      const targets = (ld.data || []).filter((a) => (a.name || "").includes("SPIKE"));
      const deleted = [];
      if (req.query.delete === "1") {
        for (const t of targets) {
          const dr = await fetch(`${META_BASE}/${t.id}?access_token=${META_TOKEN}`, { method: "DELETE" });
          deleted.push({ id: t.id, name: t.name, resp: await dr.json() });
        }
      }
      return res.status(200).json({ found: targets, deleted });
    }

    // ── 앱 정보 진단 (Live 전환 전 점검: app id, 카테고리, 개인정보처리방침 URL 등) ──
    if (action === "app_info") {
      const out = {};
      // 1) 토큰이 속한 앱
      try {
        const r = await fetch(`${META_BASE}/app?fields=id,name,namespace,category,link,app_type&access_token=${META_TOKEN}`);
        out.app = await r.json();
      } catch (e) { out.app = { error: e.message }; }
      const appId = out.app && out.app.id;
      // 2) 앱 상세 설정 — 필드별로 따로 조회(토큰 권한 부족 필드는 그 필드만 누락/에러로 표시)
      if (appId) {
        const fieldsTry = ["app_type", "category", "subcategory", "privacy_policy_url", "terms_of_service_url", "app_domains", "contact_email", "user_support_email", "object_store_urls"];
        out.app_detail = {};
        for (const f of fieldsTry) {
          try {
            const r = await fetch(`${META_BASE}/${appId}?fields=${f}&access_token=${META_TOKEN}`);
            const d = await r.json();
            out.app_detail[f] = d.error ? `ERR: ${fbErr(d.error)}` : (f in d ? d[f] : "(not returned)");
          } catch (e) { out.app_detail[f] = `ERR: ${e.message}`; }
        }
      }
      // 3) 토큰 디버그 (만료/스코프/타입 + granular_scopes = 권한이 실제 부여된 자산)
      try {
        const r = await fetch(`${META_BASE}/debug_token?input_token=${META_TOKEN}&access_token=${META_TOKEN}`);
        const d = await r.json();
        out.token = d.data ? {
          app_id: d.data.app_id, type: d.data.type, application: d.data.application,
          is_valid: d.data.is_valid, expires_at: d.data.expires_at, data_access_expires_at: d.data.data_access_expires_at,
          scopes: d.data.scopes, granular_scopes: d.data.granular_scopes,
        } : d;
      } catch (e) { out.token = { error: e.message }; }
      return res.status(200).json(out);
    }

    // ── 고아 광고세트 정리 (광고 0개 = 단건 폼이 크리에이티브 단계에서 실패해 남은 빈 세트) ──
    //   dry-run 기본(found만 반환). 삭제는 ?delete=1. 선택 필터: ?name=부분문자열, ?all=1(PAUSED 외 포함)
    if (action === "orphan_cleanup") {
      const onlyPaused   = req.query.all !== "1";
      const nameContains = req.query.name || "";
      const lr = await fetch(`${META_BASE}/${AD_ACCOUNT}/adsets?fields=id,name,status,created_time,ads.limit(1){id}&limit=500&access_token=${META_TOKEN}`);
      const ld = await lr.json();
      if (ld.error) return res.status(400).json({ error: fbErr(ld.error) });
      const targets = (ld.data || []).filter((a) => {
        const adCount = (a.ads && a.ads.data) ? a.ads.data.length : 0;
        if (adCount > 0) return false;                                  // 광고가 있으면 제외
        if (onlyPaused && a.status !== "PAUSED") return false;          // 기본은 PAUSED만
        if (nameContains && !(a.name || "").includes(nameContains)) return false;
        return true;
      });
      const deleted = [];
      if (req.query.delete === "1") {
        for (const t of targets) {
          const dr = await fetch(`${META_BASE}/${t.id}?access_token=${META_TOKEN}`, { method: "DELETE" });
          deleted.push({ id: t.id, name: t.name, resp: await dr.json() });
        }
      }
      return res.status(200).json({ count: targets.length, found: targets, deleted });
    }

    // ── [임시 진단 · 검증 후 제거] 캐러셀 크리에이티브 페이로드 변형 테스트 (adset/ad 안 만듦) ──
    if (action === "carousel_creative_test") {
      const { cards = [], caption = "" } = req.body || {};
      const UTM = `utm_source=facebook&utm_medium=display&utm_campaign=ozkizmall&utm_content={{ad.name}}`;
      const addUtm = (u) => u ? `${u}${u.includes("?") ? "&" : "?"}${UTM}` : u;
      const ca = cards.map((c) => {
        const cl = addUtm(c.link);
        return { image_hash: c.image_hash, link: cl, name: c.name, call_to_action: { type: "SHOP_NOW", value: { link: cl } } };
      });
      const firstLink = ca[0]?.link;
      const variants = {
        A_no_toplink:        { name: "SPIKE_cc_A", object_story_spec: { page_id: PAGE_ID, link_data: { message: caption, multi_share_end_card: false, multi_share_optimized: false, child_attachments: ca } } },
        B_toplink:           { name: "SPIKE_cc_B", object_story_spec: { page_id: PAGE_ID, link_data: { link: firstLink, message: caption, multi_share_end_card: false, multi_share_optimized: false, child_attachments: ca } } },
        C_toplink_noopt:     { name: "SPIKE_cc_C", object_story_spec: { page_id: PAGE_ID, link_data: { link: firstLink, message: caption, multi_share_end_card: false, child_attachments: ca } } },
        D_toplink_plain:     { name: "SPIKE_cc_D", object_story_spec: { page_id: PAGE_ID, link_data: { link: firstLink, message: caption, child_attachments: ca } } },
        E_single_image:      { name: "SPIKE_cc_E", object_story_spec: { page_id: PAGE_ID, link_data: { image_hash: cards[0]?.image_hash, link: firstLink, message: caption, call_to_action: { type: "SHOP_NOW", value: { link: firstLink } } } } },
      };
      const out = {};
      for (const [k, payload] of Object.entries(variants)) {
        const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/adcreatives?access_token=${META_TOKEN}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        out[k] = await r.json();
      }
      return res.status(200).json({ tried_cards: ca.length, results: out });
    }

    // ── 기존: 광고 목록 조회 ──────────────────────────────────────
    if (action === "get_ads") {
      const now   = new Date();
      const kstOffset = 9 * 60 * 60 * 1000;
      const kstNow = new Date(now.getTime() + kstOffset);
      const today = kstNow.toISOString().split("T")[0]; // KST 기준 오늘
      const fields = [
        "id", "name", "status", "effective_status", "daily_budget",
        "adset{id,daily_budget}",
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

    // ── 신규: 광고세트 단위 일자별·시간대별 인사이트 (최근 N일, KST 오늘 포함) ──
    if (action === "get_adset_insights") {
      // days: 기본 3. 쿼리스트링은 문자열이므로 정수 변환 후 1~90 범위로 클램프
      const days = Math.min(Math.max(parseInt(req.query.days || "3", 10) || 3, 1), 90);

      // KST 기준: 오늘을 until 로, 거기서 N-1일 전을 since 로 (오늘 포함 최근 N일)
      const kstNow          = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const server_time_kst = kstNow.getUTCHours();          // 현재 KST 시(0~23)
      const until           = kstNow.toISOString().split("T")[0];
      const sinceDate       = new Date(kstNow.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const since           = sinceDate.toISOString().split("T")[0];

      const fields         = ["adset_id", "adset_name", "spend", "actions", "action_values"].join(",");
      const PURCHASE       = "offsite_conversion.fb_pixel_purchase";
      const HOUR_BREAKDOWN = "hourly_stats_aggregated_by_advertiser_time_zone";

      // level=adset, time_increment=1(일자) + hourly breakdown(시간대),
      // 1-day click 어트리뷰션 고정(광고관리자와 일치), paging.next 끝까지 추적
      let url =
        `${META_BASE}/${AD_ACCOUNT}/insights?access_token=${META_TOKEN}` +
        `&level=adset&time_increment=1` +
        `&breakdowns=${HOUR_BREAKDOWN}` +
        `&action_attribution_windows=${encodeURIComponent(JSON.stringify(["1d_click"]))}` +
        `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
        `&fields=${encodeURIComponent(fields)}&limit=1000`;

      const rows = [];
      let guard = 0; // 무한루프 방지 (최대 100페이지)
      while (url && guard < 100) {
        const r = await fetch(url);
        const data = await r.json();
        if (data.error) return res.status(400).json({ error: data.error.message });
        if (Array.isArray(data.data)) rows.push(...data.data);
        url = data.paging?.next || null;
        guard++;
      }

      // offsite_conversion.fb_pixel_purchase의 1d_click 값 추출 (없으면 value 폴백)
      const pick = (arr) => {
        const a = (arr || []).find((x) => x.action_type === PURCHASE);
        if (!a) return 0;
        const v = a["1d_click"] != null ? a["1d_click"] : a.value;
        return parseFloat(v) || 0;
      };
      const roasOf = (spend, value) =>
        spend > 0 ? Math.round((value / spend) * 1000) / 10 : null; // %, 소수 1자리

      // adset_id → date → hour 계층으로 묶기
      const map = new Map();
      for (const row of rows) {
        const id = row.adset_id;
        if (!map.has(id)) {
          map.set(id, { adset_id: id, adset_name: row.adset_name || "", _days: new Map() });
        }
        const a = map.get(id);

        const date = row.date_start;
        if (!a._days.has(date)) a._days.set(date, { date, _hours: new Map() });
        const d = a._days.get(date);

        // "06:00:00 - 06:59:59" → 6
        const hourLabel = row[HOUR_BREAKDOWN] || "";
        const hour = parseInt(hourLabel.split(":")[0], 10);
        if (Number.isNaN(hour)) continue;

        const spend          = parseFloat(row.spend || 0) || 0;
        const purchases      = pick(row.actions);
        const purchase_value = pick(row.action_values);

        // 동일 (date,hour) 중복 행 대비 누적
        const prev = d._hours.get(hour) || { hour, spend: 0, purchases: 0, purchase_value: 0 };
        prev.spend          += spend;
        prev.purchases      += purchases;
        prev.purchase_value += purchase_value;
        d._hours.set(hour, prev);
      }

      // 계층 정리 + 합계 계산
      const round2 = (n) => Math.round(n * 100) / 100;
      const adsets = [...map.values()].map((a) => {
        const dayArr = [...a._days.values()]
          .sort((x, y) => (x.date < y.date ? -1 : 1))
          .map((d) => {
            const hours = [...d._hours.values()]
              .sort((x, y) => x.hour - y.hour)
              .map((h) => ({
                hour: h.hour,
                spend: round2(h.spend),
                purchases: h.purchases,
                purchase_value: round2(h.purchase_value),
              }));
            const dt = hours.reduce((s, h) => ({
              spend:          s.spend + h.spend,
              purchases:      s.purchases + h.purchases,
              purchase_value: s.purchase_value + h.purchase_value,
            }), { spend: 0, purchases: 0, purchase_value: 0 });
            return {
              date: d.date,
              hours,
              total: {
                spend:          round2(dt.spend),
                purchases:      dt.purchases,
                purchase_value: round2(dt.purchase_value),
                roas:           roasOf(dt.spend, dt.purchase_value),
              },
            };
          });

        const at = dayArr.reduce((s, d) => ({
          spend:          s.spend + d.total.spend,
          purchases:      s.purchases + d.total.purchases,
          purchase_value: s.purchase_value + d.total.purchase_value,
        }), { spend: 0, purchases: 0, purchase_value: 0 });

        return {
          adset_id: a.adset_id,
          adset_name: a.adset_name,
          days: dayArr,
          total: {
            spend:          round2(at.spend),
            purchases:      at.purchases,
            purchase_value: round2(at.purchase_value),
            roas:           roasOf(at.spend, at.purchase_value),
          },
        };
      });

      return res.status(200).json({ since, until, days, count: adsets.length, server_time_kst, adsets });
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
      if (data.error) return res.status(400).json({ error: `이미지 업로드 실패: ${fbErr(data.error)}` });
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
      if (data.error) return res.status(400).json({ error: `영상 업로드 실패: ${fbErr(data.error)}` });
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
        // 캐러셀: [{ image_hash, link, name }] (카드 순서 = 배열 순서)
        cards,
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
        optimization_goal: "OFFSITE_CONVERSIONS",
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
      if (adSetData.error) return res.status(400).json({ error: `광고세트 생성 실패: ${fbErr(adSetData.error)}` });
      const adset_id = adSetData.id;

      // 2) 크리에이티브 생성
      let creativeBody = { name: ad_name };
      // 랜딩 URL에 UTM 부착 (캐러셀은 ad-level landing_url이 없으므로 안전 가드)
      const addUtm = (u) => u ? `${u}${u.includes("?") ? "&" : "?"}${UTM}` : u;
      const urlWithUtm = addUtm(landing_url || "");

      if (ad_type === "CAROUSEL" && Array.isArray(cards) && cards.length >= 2) {
        // 캐러셀: child_attachments에 입력 카드만. 마지막 자동 카드(end card) 끄기, 카드 순서 고정.
        creativeBody.object_story_spec = {
          page_id: PAGE_ID,
          link_data: {
            message: caption || "",
            multi_share_end_card: false,   // end card 자동 추가 끔
            multi_share_optimized: false,  // 카드 순서 = 입력 순서 (자동 재정렬 끔)
            child_attachments: cards.map((c) => {
              const cl = addUtm(c.link);
              return {
                image_hash: c.image_hash,
                link: cl,
                name: c.name,
                call_to_action: { type: "SHOP_NOW", value: { link: cl } },
              };
            }),
          },
        };
      } else if (ad_type === "IMAGE" && image_hash) {
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
      if (creativeData.error) return res.status(400).json({ error: `크리에이티브 생성 실패: ${fbErr(creativeData.error)}`, debug_creative_body: creativeBody });
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
      if (adData.error) return res.status(400).json({ error: `광고 생성 실패: ${fbErr(adData.error)}` });

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

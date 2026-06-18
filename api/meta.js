import { fbErr, createAd, uploadImage } from "../lib/meta.js";
import { AD_MEDIA_FOLDER, driveKey, listFolder, findByName, downloadBase64 } from "../lib/drive.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const META_TOKEN = process.env.META_ACCESS_TOKEN_AD_AUTO || process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  const CATALOG_ID = process.env.META_CATALOG_ID;
  const PIXEL_ID   = process.env.META_PIXEL_ID;
  const PAGE_ID    = process.env.META_PAGE_ID;
  const APP_ID     = process.env.META_APP_EVENT_ID || "120624955209649"; // 오즈키즈 앱 이벤트 추적용
  const META_BASE  = "https://graph.facebook.com/v21.0";

  if (!META_TOKEN) return res.status(500).json({ error: "META_ACCESS_TOKEN not configured" });

  const { action } = req.query;

  try {

    // ── [임시 스파이크 · 검증 후 제거] advideos file_url 검증 (Drive URL → Meta 직접 ingest) ──
    //   ?id=FILE_ID. Drive API 미디어 URL을 file_url로 넘겨 Meta가 직접 받아가는지 확인.
    if (action === "vurl_test") {
      const KEY = process.env.GOOGLE_DRIVE_API_KEY;
      if (!KEY) return res.status(500).json({ error: "GOOGLE_DRIVE_API_KEY not configured" });
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const fileUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${KEY}`;
      const t0 = Date.now();
      const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/advideos?access_token=${META_TOKEN}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: fileUrl, name: req.query.name || "vurl_test.mp4" }),
      });
      const d = await r.json();
      const elapsed_ms = Date.now() - t0;
      if (d.error) return res.status(400).json({ error: `advideos file_url 실패: ${fbErr(d.error)}`, elapsed_ms });
      return res.status(200).json({ video_id: d.id, elapsed_ms });
    }

    // ── [임시 스파이크 · 검증 후 제거] Drive 폴더 파일명 검색 → 다운로드 검증 ──
    //   공개 폴더("링크 있는 모든 사용자 뷰어") + Drive API 키 방식. 서비스 계정 미사용.
    //   1) 폴더 리스트 → 이미지/영상 자동 선택  2) 파일명으로 재검색(=production 경로)
    //   3) alt=media 다운로드 → 받은 바이트 == 보고된 size 인지(완전 수신) 검증
    if (action === "drive_test") {
      const KEY = driveKey();
      if (!KEY) return res.status(500).json({ error: "GOOGLE_DRIVE_API_KEY not configured" });
      const out = {};

      // 1) 폴더 리스트 (lib/drive.js)
      const lst = await listFolder(AD_MEDIA_FOLDER, KEY);
      if (!lst.ok) return res.status(400).json({ error: `files.list 실패: ${lst.error}` });
      const files = lst.files;
      out.folder_files = files.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.size }));

      // 2) 이미지 1 · 영상 1 자동 선택 — 기본은 '가장 큰' 파일. ?img=/vid= 부분일치로 강제.
      const sz = (f) => (f.size != null ? Number(f.size) : 0);
      const biggest = (pred) => files.filter(pred).sort((a, b) => sz(b) - sz(a))[0];
      const pickImg = req.query.img ? files.find((f) => f.name.includes(req.query.img))
        : biggest((f) => (f.mimeType || "").startsWith("image/"));
      const pickVid = req.query.vid ? files.find((f) => f.name.includes(req.query.vid))
        : biggest((f) => (f.mimeType || "").startsWith("video/"));

      // 파일명 재검색(production 경로, lib) → 다운로드(lib) → 바이트 검증
      const verify = async (file, label) => {
        if (!file) return { label, error: "폴더에서 해당 유형 파일을 못 찾음" };
        const r = { label, name: file.name };
        const s = await findByName(AD_MEDIA_FOLDER, file.name, KEY);
        if (!s.ok) { r.search_error = s.error; return r; }
        r.search_hits = s.hits;               // 1이어야 정상(0=없음, 2+=중복)
        if (s.hits !== 1) { r.search_note = s.hits === 0 ? "검색 0건" : "동명 중복"; return r; }
        r.file_id = s.file.id;
        r.mimeType = s.file.mimeType;
        r.reported_size = s.file.size != null ? Number(s.file.size) : null;
        const t0 = Date.now();
        const dl = await downloadBase64(s.file.id, KEY);
        if (!dl.ok) { r.download_error = dl.error; return r; }
        r.downloaded_bytes = dl.bytes;
        r.elapsed_ms = Date.now() - t0;
        r.complete = r.reported_size != null ? (dl.bytes === r.reported_size) : "size 미보고";
        return r;
      };

      out.image = await verify(pickImg, "image");
      out.video = await verify(pickVid, "video");
      return res.status(200).json(out);
    }

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

    // ── 광고세트 설정 조회 (생성 검증용: optimization_goal, targeting.locales 등) ──
    if (action === "get_adset") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await fetch(`${META_BASE}/${id}?fields=id,name,status,campaign_id,optimization_goal,billing_event,bid_strategy,daily_budget,destination_type,promoted_object,attribution_spec,targeting&access_token=${META_TOKEN}`);
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: fbErr(d.error) });
      return res.status(200).json(d);
    }

    // ── 광고세트 삭제 (하위 광고 cascade 삭제 — 테스트 정리용) ──
    if (action === "delete_adset") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const r = await fetch(`${META_BASE}/${id}?access_token=${META_TOKEN}`, { method: "DELETE" });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: fbErr(d.error) });
      return res.status(200).json({ deleted: id, resp: d });
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

    // ── 신규: 이미지 업로드 — 공용 uploadImage (단건/대량 공유) ──
    if (action === "upload_image") {
      const { image_base64, filename } = req.body;
      if (!image_base64) return res.status(400).json({ error: "image_base64 required" });
      const up = await uploadImage(image_base64, filename, { META_TOKEN, AD_ACCOUNT });
      if (!up.ok) return res.status(400).json({ error: up.error });
      return res.status(200).json({ hash: up.hash });
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

    // ── 신규: 광고 생성 (PAUSED) — 공용 createAd 호출 (단건/대량 공유) ──
    if (action === "create_ad") {
      const r = await createAd(req.body, { META_TOKEN, AD_ACCOUNT, PIXEL_ID, PAGE_ID, APP_ID });
      // 기존 단건 응답 형태 1:1 보존 (성공 / 소재없음 경고 / 에러+debug)
      if (r.error) {
        return res.status(400).json(r.debug ? { error: r.error, debug_creative_body: r.debug } : { error: r.error });
      }
      if (r.warning) {
        return res.status(200).json({ adset_id: r.adset_id, ad_id: null, warning: r.warning });
      }
      return res.status(200).json({ success: true, adset_id: r.adset_id, creative_id: r.creative_id, ad_id: r.ad_id });
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

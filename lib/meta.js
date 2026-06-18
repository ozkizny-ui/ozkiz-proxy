// Meta Graph 공용 로직 — 단건(api/meta.js)·대량(api/bulk-create-ads.js) 공유.
// 작업지시서 v2 §5: "기존 create_ad를 재사용. 단건 로직 복제 금지."
// CommonJS — Vercel(esbuild→CJS) / 로컬 node 양쪽 안전. (.mjs는 CJS require 시 ERR_REQUIRE_ESM)

const META_BASE = "https://graph.facebook.com/v21.0";

// Meta 그래프 에러를 진단 가능한 한 줄로 펼침 (message만으론 "Invalid parameter"라 원인 불명)
function fbErr(err) {
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
}

// 광고 생성 (광고세트 → 크리에이티브 → 광고, PAUSED). 단건/대량 공용.
//
// body: {
//   ad_type,            // IMAGE | VIDEO | COLLECTION | PA | CAROUSEL
//   campaign_id, ad_name,
//   landing_url, caption,
//   image_hash,                       // IMAGE
//   video_id,                         // VIDEO
//   product_set_id, collection_label, // COLLECTION
//   post_url,                         // PA
//   cards,                            // CAROUSEL: [{ image_hash, link, name }] (카드 순서 = 배열 순서)
// }
// ctx: { META_TOKEN, AD_ACCOUNT, PIXEL_ID, PAGE_ID, APP_ID }
//
// 반환(구조화 — 호출측이 HTTP/누적결과로 매핑):
//   성공:      { ok:true,  stage:"ad",    adset_id, creative_id, ad_id }
//   소재없음:  { ok:true,  stage:"adset", adset_id, ad_id:null, warning }
//   실패:      { ok:false, stage:"validate|adset|creative|ad", error, debug?, adset_id?, creative_id? }
async function createAd(body, ctx) {
  const { META_TOKEN, AD_ACCOUNT, PIXEL_ID, PAGE_ID, APP_ID } = ctx;
  const {
    ad_type, campaign_id, ad_name, landing_url, caption,
    image_hash, video_id, thumbnail_url, thumbnail_hash, product_set_id, collection_label, post_url, cards,
  } = body || {};

  if (!campaign_id || !ad_name) {
    return { ok: false, stage: "validate", error: "campaign_id, ad_name required" };
  }

  const UTM = `utm_source=facebook&utm_medium=display&utm_campaign=ozkizmall&utm_content={{ad.name}}`;
  const trackingSpec = [
    { "action.type": ["offsite_conversion"], "fb_pixel": [PIXEL_ID] },  // 웹사이트(픽셀) 이벤트
    { "action.type": ["app_custom_event"], "application": [APP_ID] },    // 앱 이벤트
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
    promoted_object: { pixel_id: PIXEL_ID, custom_event_type: "PURCHASE" },
    attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
    targeting: {
      geo_locations: { countries: ["KR"] },
      locales: [12], // 한국어 (ko) — Meta adlocale 코드 12
    },
  };
  const adSetRes = await fetch(`${META_BASE}/${AD_ACCOUNT}/adsets?access_token=${META_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(adSetBody),
  });
  const adSetData = await adSetRes.json();
  if (adSetData.error) return { ok: false, stage: "adset", error: `광고세트 생성 실패: ${fbErr(adSetData.error)}` };
  const adset_id = adSetData.id;

  // 2) 크리에이티브 생성
  let creativeBody = { name: ad_name };
  const addUtm = (u) => u ? `${u}${u.includes("?") ? "&" : "?"}${UTM}` : u; // 캐러셀은 ad-level URL 없으므로 안전 가드
  const urlWithUtm = addUtm(landing_url || "");

  if (ad_type === "CAROUSEL" && Array.isArray(cards) && cards.length >= 2) {
    // 캐러셀: child_attachments에 입력 카드만. end card 자동추가 끔, 카드 순서 고정.
    creativeBody.object_story_spec = {
      page_id: PAGE_ID,
      link_data: {
        message: caption || "",
        multi_share_end_card: false,
        multi_share_optimized: false,
        child_attachments: cards.map((c) => {
          const cl = addUtm(c.link);
          return { image_hash: c.image_hash, link: cl, name: c.name, call_to_action: { type: "SHOP_NOW", value: { link: cl } } };
        }),
      },
    };
  } else if (ad_type === "IMAGE" && image_hash) {
    creativeBody.object_story_spec = {
      page_id: PAGE_ID,
      link_data: { image_hash, link: urlWithUtm, message: caption, call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } } },
    };
  } else if (ad_type === "VIDEO" && video_id) {
    // Meta는 영상 광고에 썸네일 필수(subcode 1443226). 영상 ready 후 thumbnail uri를 image_url로.
    const video_data = { video_id, call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } }, message: caption };
    if (thumbnail_url) video_data.image_url = thumbnail_url;
    else if (thumbnail_hash) video_data.image_hash = thumbnail_hash;
    creativeBody.object_story_spec = { page_id: PAGE_ID, video_data };
  } else if (ad_type === "COLLECTION" && product_set_id) {
    creativeBody.object_story_spec = {
      page_id: PAGE_ID,
      link_data: { link: urlWithUtm, message: caption, call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } }, child_attachments: [] },
    };
    creativeBody.product_set_id = product_set_id;
    if (collection_label) creativeBody.label = collection_label;
  } else if (ad_type === "PA" && post_url) {
    creativeBody.object_story_spec = {
      page_id: PAGE_ID,
      link_data: { link: urlWithUtm, message: caption || "", call_to_action: { type: "SHOP_NOW", value: { link: urlWithUtm } } },
    };
    creativeBody.instagram_permalink_url = post_url;
    creativeBody.enable_direct_install = false;
  } else {
    // 크리에이티브 없이 세트만 생성된 경우
    return { ok: true, stage: "adset", adset_id, ad_id: null, warning: "소재 미업로드 - 광고세트만 생성됨. 메타 광고관리자에서 소재를 직접 추가해주세요." };
  }

  const creativeRes = await fetch(`${META_BASE}/${AD_ACCOUNT}/adcreatives?access_token=${META_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creativeBody),
  });
  const creativeData = await creativeRes.json();
  if (creativeData.error) return { ok: false, stage: "creative", error: `크리에이티브 생성 실패: ${fbErr(creativeData.error)}`, debug: creativeBody, adset_id };
  const creative_id = creativeData.id;

  // 3) 광고 생성
  const adRes = await fetch(`${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: ad_name, adset_id, creative: { creative_id }, status: "PAUSED", tracking_specs: trackingSpec }),
  });
  const adData = await adRes.json();
  if (adData.error) return { ok: false, stage: "ad", error: `광고 생성 실패: ${fbErr(adData.error)}`, adset_id, creative_id };

  return { ok: true, stage: "ad", adset_id, creative_id, ad_id: adData.id };
}

// 이미지 업로드 — adimages는 base64 `bytes` 정식 지원(이미지는 작아 Vercel 한도 무관).
// (참고: advideos는 base64 미지원 → 영상은 uploadVideoByUrl 사용)
// 반환: { ok:true, hash } | { ok:false, error }
async function uploadImage(base64, filename, ctx) {
  const { META_TOKEN, AD_ACCOUNT } = ctx;
  const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/adimages?access_token=${META_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytes: base64, name: filename || "image.jpg" }),
  });
  const d = await r.json();
  if (d.error) return { ok: false, error: `이미지 업로드 실패: ${fbErr(d.error)}` };
  const hash = Object.values(d.images || {})[0] && Object.values(d.images || {})[0].hash;
  return hash ? { ok: true, hash } : { ok: false, error: "이미지 업로드 응답에 hash 없음" };
}

// 영상 업로드 — advideos의 file_url로 Meta가 공개 URL에서 직접 받아감.
// proxy가 바이트를 안 만져 Vercel 4.5MB 한도·메모리/타임아웃 회피. (단건 로컬파일은 file_url 불가 → 백로그)
// 반환: { ok:true, video_id } | { ok:false, error }
async function uploadVideoByUrl(fileUrl, filename, ctx) {
  const { META_TOKEN, AD_ACCOUNT } = ctx;
  const r = await fetch(`${META_BASE}/${AD_ACCOUNT}/advideos?access_token=${META_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_url: fileUrl, name: filename || "video.mp4" }),
  });
  const d = await r.json();
  if (d.error) return { ok: false, error: `영상 업로드 실패: ${fbErr(d.error)}` };
  return { ok: true, video_id: d.id };
}

// 영상 처리상태 조회 (create_ad 전 ready 확인용). status: processing|ready|error
async function getVideoStatus(videoId, ctx) {
  const { META_TOKEN } = ctx;
  const r = await fetch(`${META_BASE}/${videoId}?fields=status&access_token=${META_TOKEN}`);
  const d = await r.json();
  if (d.error) return { ok: false, error: fbErr(d.error) };
  return { ok: true, status: d.status && d.status.video_status };
}

// 영상 썸네일 조회 (ready 후) — 선호 썸네일 uri 반환 (video_data.image_url용)
async function getVideoThumbnail(videoId, ctx) {
  const { META_TOKEN } = ctx;
  const r = await fetch(`${META_BASE}/${videoId}/thumbnails?fields=uri,is_preferred&access_token=${META_TOKEN}`);
  const d = await r.json();
  if (d.error) return { ok: false, error: fbErr(d.error) };
  const list = d.data || [];
  const pick = list.find((t) => t.is_preferred) || list[0];
  return pick ? { ok: true, uri: pick.uri } : { ok: false, error: "썸네일 없음(아직 미생성)" };
}

module.exports = { META_BASE, fbErr, createAd, uploadImage, uploadVideoByUrl, getVideoStatus, getVideoThumbnail };

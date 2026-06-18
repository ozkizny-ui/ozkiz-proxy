// 광고 대량 업로드 오케스트레이션 (작업지시서 v2 §5). image/video.
// 기존 createAd 재사용(단건 로직 복제 금지). 미디어: 이미지=base64 bytes, 영상=Drive file_url.
//
// 입력(POST): { rows: [ { rowIndex?, type, campaign, filename, caption?, landing_url } ], dry_run? }
//   type        image | video
//   campaign    캠페인명 또는 campaign_id (기존 캠페인 재사용)
//   filename    Drive 폴더 내 파일명(확장자 포함). 확장자·카드번호 떼면 광고세트명/광고명
//   landing_url 랜딩 URL (UTM 자동 부착은 createAd가 처리)
//   dry_run     true면 검증·캠페인·Drive존재까지만 (생성 안 함) — 미리보기용
//
// 출력: { summary:{total,success,failed}, results:[ {rowIndex,status,stage,ad_name,adset_id,ad_id,ad_permalink,message} ] }
//
// Vercel 함수시간 한도 때문에 한 요청은 소량(1~수 행) 권장 — 20행은 프론트가 청크로 나눠 호출(진행률).

import { createAd, uploadImage, uploadVideoByUrl, fbErr } from "../lib/meta.js";
import { AD_MEDIA_FOLDER, driveKey, mediaUrl, findByName, downloadBase64 } from "../lib/drive.js";
import { parseMediaFilename } from "../lib/filename.js";

export const config = { maxDuration: 60 }; // 영상 ingest(파일당 ~10s+) 여유

const META_BASE = "https://graph.facebook.com/v21.0";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const META_TOKEN = process.env.META_ACCESS_TOKEN_AD_AUTO || process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  const PIXEL_ID   = process.env.META_PIXEL_ID;
  const PAGE_ID    = process.env.META_PAGE_ID;
  const APP_ID     = process.env.META_APP_EVENT_ID || "120624955209649";
  const KEY        = driveKey();
  const ctx = { META_TOKEN, AD_ACCOUNT, PIXEL_ID, PAGE_ID, APP_ID };

  if (!META_TOKEN) return res.status(500).json({ error: "META_ACCESS_TOKEN 미설정" });
  if (!KEY)        return res.status(500).json({ error: "GOOGLE_DRIVE_API_KEY 미설정" });

  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const dryRun = body.dry_run === true;
  if (!rows.length) return res.status(400).json({ error: "rows 비어있음" });

  try {
    // 캠페인 1회 조회 → name→id / id집합 캐시 (신규 생성 안 함)
    const cr = await fetch(`${META_BASE}/${AD_ACCOUNT}/campaigns?access_token=${META_TOKEN}&fields=id,name,status&limit=500`);
    const cd = await cr.json();
    if (cd.error) return res.status(400).json({ error: `캠페인 조회 실패: ${fbErr(cd.error)}` });
    const campaigns = cd.data || [];
    const byName = new Map(campaigns.map((c) => [c.name, c.id]));
    const idSet  = new Set(campaigns.map((c) => c.id));

    const mediaCache = new Map(); // file.id -> { image_hash } | { video_id }
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = row.rowIndex != null ? row.rowIndex : i + 1;
      const push = (status, stage, extra) => results.push({ rowIndex, status, stage, ...(extra || {}) });

      try {
        const type        = String(row.type || "").trim().toLowerCase();
        const campaign    = String(row.campaign || "").trim();
        const filename    = String(row.filename || "").trim();
        const caption     = row.caption || "";
        const landing_url = String(row.landing_url || "").trim();

        // 1) 행 검증
        if (!["image", "video"].includes(type)) { push("error", "validate", { message: `type 오류('${row.type}') — image/video만 지원` }); continue; }
        if (!filename)    { push("error", "validate", { message: "파일명 비어있음" }); continue; }
        if (!campaign)    { push("error", "validate", { message: "캠페인 비어있음" }); continue; }
        if (!landing_url) { push("error", "validate", { message: "랜딩URL 비어있음" }); continue; }
        try { new URL(landing_url); } catch { push("error", "validate", { message: `랜딩URL 형식 오류: ${landing_url}` }); continue; }

        // 2) 캠페인 resolve (id 직접 또는 이름 매칭)
        const campaign_id = idSet.has(campaign) ? campaign : byName.get(campaign);
        if (!campaign_id) { push("error", "campaign", { message: `캠페인 못 찾음: '${campaign}' — 정확한 캠페인명/ID 확인` }); continue; }

        // 3) Drive 파일명 검색 (0건/중복 탐지)
        const found = await findByName(AD_MEDIA_FOLDER, filename, KEY);
        if (!found.ok)        { push("error", "media", { message: `Drive 검색 실패: ${found.error}` }); continue; }
        if (found.hits === 0) { push("error", "media", { message: `Drive 폴더에 '${filename}' 없음 — 업로드/철자 확인` }); continue; }
        if (found.hits > 1)   { push("error", "media", { message: `Drive 폴더에 동명 파일 ${found.hits}개 — 이름 구분 필요` }); continue; }
        const file = found.file;
        const mime = file.mimeType || "";
        if (type === "image" && !mime.startsWith("image/")) { push("error", "media", { message: `type=image인데 파일이 이미지 아님(${mime})` }); continue; }
        if (type === "video" && !mime.startsWith("video/")) { push("error", "media", { message: `type=video인데 파일이 영상 아님(${mime})` }); continue; }

        // 4) 광고명/광고세트명 = 파일명(확장자·카드번호 제거)
        const { adName } = parseMediaFilename(filename);

        if (dryRun) { push("ok", "validate", { ad_name: adName, file_id: file.id, size: file.size, message: "검증 통과" }); continue; }

        // 5) 미디어 준비 (동일 파일 1회만 업로드 — FILE 캐시)
        let media = mediaCache.get(file.id);
        if (!media) {
          if (type === "image") {
            const dl = await downloadBase64(file.id, KEY);
            if (!dl.ok) { push("error", "media", { ad_name: adName, message: dl.error }); continue; }
            const up = await uploadImage(dl.base64, filename, ctx);
            if (!up.ok) { push("error", "media", { ad_name: adName, message: up.error }); continue; }
            media = { image_hash: up.hash };
          } else {
            const up = await uploadVideoByUrl(mediaUrl(file.id, KEY), filename, ctx);
            if (!up.ok) { push("error", "media", { ad_name: adName, message: up.error }); continue; }
            media = { video_id: up.video_id };
          }
          mediaCache.set(file.id, media);
        }

        // 6) 광고 생성 (광고세트→크리에이티브→광고, PAUSED) — 공용 createAd
        const r = await createAd(
          { ad_type: type.toUpperCase(), campaign_id, ad_name: adName, landing_url, caption, ...media },
          ctx
        );
        if (!r.ok) { push("error", r.stage, { ad_name: adName, adset_id: r.adset_id, message: r.error }); continue; }
        push("ok", "ad", {
          ad_name: adName, adset_id: r.adset_id, creative_id: r.creative_id, ad_id: r.ad_id,
          ad_permalink: `https://business.facebook.com/adsmanager/manage/ads?act=${String(AD_ACCOUNT).replace(/^act_/, "")}&selected_ad_ids=${r.ad_id}`,
        });
      } catch (e) {
        push("error", "exception", { message: e.message });
      }
    }

    const success = results.filter((r) => r.status === "ok").length;
    return res.status(200).json({ summary: { total: rows.length, success, failed: rows.length - success }, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

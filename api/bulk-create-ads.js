// 광고 대량 업로드 오케스트레이션 (작업지시서 v2 §5). image / video / carousel.
// 기존 createAd 재사용(단건 로직 복제 금지). 미디어: 이미지=base64 bytes, 영상=Drive file_url.
//
// 입력(POST): { rows: [...], dry_run? }
//   공통:    rowIndex?, type(image|video|carousel), campaign(명 또는 id)
//   image/video: filename, landing_url, caption?
//   carousel:    ad_group(묶기 키), filename(카드 (1)(2)(3)), card_landing_url(카드별), caption?(그룹 첫행 1개), campaign(그룹 첫행)
//   dry_run: true면 검증·캠페인·Drive존재까지만(생성 안 함) — 미리보기용
//
// 출력: { summary:{total,success,failed}, results:[...] }
//   image/video → {rowIndex,...}, carousel → {ad_group,rowIndexes,...} (그룹 1개=결과 1개)
//
// Vercel maxDuration=60s. 영상 1건 ~50s, 캐러셀은 카드수만큼 다운로드 → 프론트가 청크로 호출(진행률).

import { createAd, uploadImage, uploadVideoByUrl, getVideoStatus, getVideoThumbnail, fbErr } from "../lib/meta.js";
import { AD_MEDIA_FOLDER, driveKey, mediaUrl, findByName, downloadBase64 } from "../lib/drive.js";
import { parseMediaFilename } from "../lib/filename.js";
import { buildCarousel } from "../lib/carousel.js";

export const config = { maxDuration: 60 };

const META_BASE = "https://graph.facebook.com/v21.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const adLink = (adId) => `https://business.facebook.com/adsmanager/manage/ads?act=${String(AD_ACCOUNT).replace(/^act_/, "")}&selected_ad_ids=${adId}`;

  try {
    // 캠페인 1회 조회 → name→id / id집합 캐시 (신규 생성 안 함)
    const cr = await fetch(`${META_BASE}/${AD_ACCOUNT}/campaigns?access_token=${META_TOKEN}&fields=id,name,status&limit=500`);
    const cd = await cr.json();
    if (cd.error) return res.status(400).json({ error: `캠페인 조회 실패: ${fbErr(cd.error)}` });
    const campaigns = cd.data || [];
    const byName = new Map(campaigns.map((c) => [c.name, c.id]));
    const idSet  = new Set(campaigns.map((c) => c.id));
    const resolveCampaign = (c) => (idSet.has(c) ? c : byName.get(c));

    const mediaCache = new Map(); // file.id -> { image_hash } | { video_id, thumbnail_url }
    const results = [];

    // 이미지 1건 준비 (FILE 캐시). 반환 { ok, image_hash } | { ok:false, error }
    async function prepImage(file, filename) {
      let m = mediaCache.get(file.id);
      if (!m) {
        const dl = await downloadBase64(file.id, KEY);
        if (!dl.ok) return { ok: false, error: dl.error };
        const up = await uploadImage(dl.base64, filename, ctx);
        if (!up.ok) return { ok: false, error: up.error };
        m = { image_hash: up.hash };
        mediaCache.set(file.id, m);
      }
      return { ok: true, image_hash: m.image_hash };
    }

    // ── image / video 행 1개 처리 ──
    async function processSimple(row, rowIndex) {
      const push = (status, stage, extra) => results.push({ rowIndex, status, stage, ...(extra || {}) });
      const type        = String(row.type || "").trim().toLowerCase();
      const campaign    = String(row.campaign || "").trim();
      const filename    = String(row.filename || "").trim();
      const caption     = row.caption || "";
      const landing_url = String(row.landing_url || "").trim();

      if (!filename)    return push("error", "validate", { message: "파일명 비어있음" });
      if (!campaign)    return push("error", "validate", { message: "캠페인 비어있음" });
      if (!landing_url) return push("error", "validate", { message: "랜딩URL 비어있음" });
      try { new URL(landing_url); } catch { return push("error", "validate", { message: `랜딩URL 형식 오류: ${landing_url}` }); }

      const campaign_id = resolveCampaign(campaign);
      if (!campaign_id) return push("error", "campaign", { message: `캠페인 못 찾음: '${campaign}' — 정확한 캠페인명/ID 확인` });

      const found = await findByName(AD_MEDIA_FOLDER, filename, KEY);
      if (!found.ok)        return push("error", "media", { message: `Drive 검색 실패: ${found.error}` });
      if (found.hits === 0) return push("error", "media", { message: `Drive 폴더에 '${filename}' 없음 — 업로드/철자 확인` });
      if (found.hits > 1)   return push("error", "media", { message: `Drive 폴더에 동명 파일 ${found.hits}개 — 이름 구분 필요` });
      const file = found.file;
      const mime = file.mimeType || "";
      if (type === "image" && !mime.startsWith("image/")) return push("error", "media", { message: `type=image인데 파일이 이미지 아님(${mime})` });
      if (type === "video" && !mime.startsWith("video/")) return push("error", "media", { message: `type=video인데 파일이 영상 아님(${mime})` });

      const { adName } = parseMediaFilename(filename);
      if (dryRun) return push("ok", "validate", { ad_name: adName, file_id: file.id, size: file.size, message: "검증 통과" });

      const tMedia = Date.now();
      let media = mediaCache.get(file.id);
      if (!media) {
        if (type === "image") {
          const pi = await prepImage(file, filename);
          if (!pi.ok) return push("error", "media", { ad_name: adName, message: pi.error });
          media = { image_hash: pi.image_hash };
        } else {
          // 영상: Drive file_url → Meta 직접 ingest → 인코딩 ready 대기 → 썸네일(필수)
          const up = await uploadVideoByUrl(mediaUrl(file.id, KEY), filename, ctx);
          if (!up.ok) return push("error", "media", { ad_name: adName, message: up.error });
          let status = "";
          for (let k = 0; k < 15; k++) {
            const s = await getVideoStatus(up.video_id, ctx);
            status = s.ok ? s.status : "";
            if (status === "ready" || status === "error") break;
            await sleep(3000);
          }
          if (status !== "ready") return push("error", "media", { ad_name: adName, message: `영상 처리 대기 초과(status=${status || "unknown"}) — 잠시 후 재시도` });
          const th = await getVideoThumbnail(up.video_id, ctx);
          if (!th.ok) return push("error", "media", { ad_name: adName, message: `썸네일 조회 실패: ${th.error}` });
          media = { video_id: up.video_id, thumbnail_url: th.uri };
          mediaCache.set(file.id, media);
        }
      }
      const media_ms = Date.now() - tMedia;

      const tCreate = Date.now();
      const r = await createAd({ ad_type: type.toUpperCase(), campaign_id, ad_name: adName, landing_url, caption, ...media }, ctx);
      const create_ms = Date.now() - tCreate;
      if (!r.ok) return push("error", r.stage, { ad_name: adName, adset_id: r.adset_id, media_ms, create_ms, message: r.error });
      push("ok", "ad", { ad_name: adName, adset_id: r.adset_id, creative_id: r.creative_id, ad_id: r.ad_id, media_ms, create_ms, elapsed_ms: media_ms + create_ms, ad_permalink: adLink(r.ad_id) });
    }

    // ── carousel 그룹 1개 처리 ──
    async function processCarousel(ad_group, groupRows) {
      const rowIndexes = groupRows.map((r) => r.rowIndex);
      const push = (status, stage, extra) => results.push({ ad_group, rowIndexes, status, stage, ...(extra || {}) });

      // 1) 순수 검증/정렬 (그룹화·adName일치·카드번호·URL·2장↑)
      const built = buildCarousel(groupRows);
      if (!built.ok) return push("error", "validate", { message: built.error });

      // 2) 캠페인
      if (!built.campaign) return push("error", "validate", { ad_name: built.adName, message: "캠페인 비어있음(그룹 첫 행에 입력)" });
      const campaign_id = resolveCampaign(built.campaign);
      if (!campaign_id) return push("error", "campaign", { ad_name: built.adName, message: `캠페인 못 찾음: '${built.campaign}'` });

      // 3) Drive 존재 확인 + 카드 다운로드/업로드 (+ dry_run이면 존재확인까지)
      const tMedia = Date.now();
      const childCards = [];
      for (const c of built.cards) {
        const f = await findByName(AD_MEDIA_FOLDER, c.filename, KEY);
        if (!f.ok)        return push("error", "media", { ad_name: built.adName, message: `Drive 검색 실패: ${f.error}` });
        if (f.hits === 0) return push("error", "media", { ad_name: built.adName, message: `카드 '${c.filename}' Drive에 없음 — 업로드/철자 확인` });
        if (f.hits > 1)   return push("error", "media", { ad_name: built.adName, message: `카드 '${c.filename}' 동명 ${f.hits}개 — 이름 구분 필요` });
        if (!(f.file.mimeType || "").startsWith("image/")) return push("error", "media", { ad_name: built.adName, message: `카드 '${c.filename}' 이미지 아님(${f.file.mimeType})` });
        if (dryRun) continue;
        // 카드 이미지 다운로드 → 업로드 (FILE 캐시)
        const pi = await prepImage(f.file, c.filename);
        if (!pi.ok) return push("error", "media", { ad_name: built.adName, message: `카드 '${c.filename}': ${pi.error}` });
        childCards.push({ image_hash: pi.image_hash, link: c.url, name: built.adName });
      }
      if (dryRun) return push("ok", "validate", { ad_name: built.adName, card_count: built.cards.length, message: "검증 통과" });
      const media_ms = Date.now() - tMedia; // 카드 N장 검색+다운로드+업로드 합계

      // 4) 캐러셀 광고 생성 (createAd 3콜)
      const tCreate = Date.now();
      const r = await createAd({ ad_type: "CAROUSEL", campaign_id, ad_name: built.adName, caption: built.caption, cards: childCards }, ctx);
      const create_ms = Date.now() - tCreate;
      if (!r.ok) return push("error", r.stage, { ad_name: built.adName, adset_id: r.adset_id, card_count: childCards.length, media_ms, create_ms, message: r.error });
      push("ok", "ad", { ad_name: built.adName, adset_id: r.adset_id, creative_id: r.creative_id, ad_id: r.ad_id, card_count: childCards.length, media_ms, create_ms, elapsed_ms: media_ms + create_ms, ad_permalink: adLink(r.ad_id) });
    }

    // ── 작업 단위 구성: image/video=행, carousel=광고그룹(첫 등장 순서 유지) ──
    const items = [];
    const gIdx = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = row.rowIndex != null ? row.rowIndex : i + 1;
      const type = String(row.type || "").trim().toLowerCase();
      if (type === "carousel") {
        const g = String(row.ad_group || "").trim();
        if (!g) { items.push({ kind: "bad", rowIndex, message: "carousel 행에 광고그룹 값 없음" }); continue; }
        if (!gIdx.has(g)) { gIdx.set(g, items.length); items.push({ kind: "carousel", ad_group: g, rows: [] }); }
        items[gIdx.get(g)].rows.push({ ...row, rowIndex });
      } else if (type === "image" || type === "video") {
        items.push({ kind: "simple", row, rowIndex });
      } else {
        items.push({ kind: "bad", rowIndex, message: `type 오류('${row.type}') — image/video/carousel만 지원` });
      }
    }

    // 순차 처리 (Meta rate limit·영상 ingest 고려). 행/그룹별 부분실패 격리.
    for (const item of items) {
      try {
        if (item.kind === "bad") results.push({ rowIndex: item.rowIndex, status: "error", stage: "validate", message: item.message });
        else if (item.kind === "simple") await processSimple(item.row, item.rowIndex);
        else if (item.kind === "carousel") await processCarousel(item.ad_group, item.rows);
      } catch (e) {
        const id = item.kind === "carousel" ? { ad_group: item.ad_group, rowIndexes: item.rows.map((r) => r.rowIndex) } : { rowIndex: item.rowIndex };
        results.push({ ...id, status: "error", stage: "exception", message: e.message });
      }
    }

    const success = results.filter((r) => r.status === "ok").length;
    return res.status(200).json({ summary: { total: results.length, success, failed: results.length - success }, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

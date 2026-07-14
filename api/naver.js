// api/naver.js — 네이버 검색광고 API 프록시 (HMAC 서명·키 서버보관). meta.js 패턴 준수.
// 읽기 액션은 open, 쓰기(입찰 변경) 액션은 NAVER_AUTH_ENABLED시 verifyBearer 게이트(기본 OFF=무중단).
// 검증 완료 형식(2026-07 Phase0):
//   - 쇼핑 입찰=소재 adAttr.bidAmt. PUT /ncc/ads/{id}?fields=adAttr (fields는 반복파라미터!)
//   - 파워링크 키워드 입찰. PUT /ncc/keywords/{id}?fields=["bidAmt"] (키워드는 JSON배열 형식)
//   - estimate: POST /estimate/average-position-bid/keyword
//   - 검색어 성과: 대용량 보고서(StatReport) — statreport_test 확정 후 연결(TODO).
import crypto from "node:crypto";
import { verifyBearer } from "../lib/auth.js";

const NAVER_BASE = "https://api.searchad.naver.com";
const READ_ACTIONS = new Set([
  "get_campaigns", "get_adgroups", "get_keywords", "get_ads",
  "estimate", "stats", "get_restricted_keywords",
  "report_create", "report_status", "report_download", "report_delete",
]);
// 대용량 보고서 reportTp (Phase0 확정): EXPKEYWORD=검색어(파워링크 전용), AD=소재별 일일성과, AD_DETAIL=키워드·소재 상세.
// 쇼핑 검색어는 API 미제공 → 제외검색어 제안은 수동 CSV 업로드 경로.

function sign(secret, ts, method, path) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${method}.${path}`).digest("base64");
}
// 입찰가 방어: 정수 10~100,000원만 허용(비정상/폭주 입찰 차단). 범위 밖이면 null.
function validBid(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 10 && n <= 100000 ? n : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;
  const API_KEY = process.env.NAVER_API_KEY;
  const SECRET_KEY = process.env.NAVER_SECRET_KEY;
  if (!CUSTOMER_ID || !API_KEY || !SECRET_KEY) {
    return res.status(500).json({ error: "NAVER_* credentials not configured" });
  }

  const action = req.query.action;
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // 쓰기(입찰 변경) fail-CLOSED: 항상 write JWT(verifyBearer) 필요. 읽기 allowlist만 open.
  // 돈이 나가는 동작이라 meta.js의 기본-OFF 게이트보다 강하게. SB_JWT_SECRET 없으면 verify=false→차단.
  if (!READ_ACTIONS.has(action) && !verifyBearer(req)) {
    return res.status(401).json({ error: "unauthorized: write action requires a valid write token" });
  }

  // 네이버 API 호출 헬퍼. path는 쿼리스트링 제외(서명용). rawQuery는 URL에만 덧붙임.
  async function nv(method, path, { rawQuery = "", jsonBody } = {}) {
    const ts = Date.now().toString();
    const r = await fetch(NAVER_BASE + path + rawQuery, {
      method,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Timestamp": ts,
        "X-API-KEY": API_KEY,
        "X-Customer": String(CUSTOMER_ID),
        "X-Signature": sign(SECRET_KEY, ts, method, path),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, ok: r.ok, data };
  }
  const q = (obj) => "?" + new URLSearchParams(obj).toString();

  try {
    switch (action) {
      // ── 읽기 ──
      case "get_campaigns":
        return relay(res, await nv("GET", "/ncc/campaigns"));
      case "get_adgroups":
        return relay(res, await nv("GET", "/ncc/adgroups", { rawQuery: q({ nccCampaignId: req.query.nccCampaignId }) }));
      case "get_keywords":
        return relay(res, await nv("GET", "/ncc/keywords", { rawQuery: q({ nccAdgroupId: req.query.nccAdgroupId }) }));
      case "get_ads":
        return relay(res, await nv("GET", "/ncc/ads", { rawQuery: q({ nccAdgroupId: req.query.nccAdgroupId }) }));

      case "estimate": {
        // body: { device:'PC'|'MOBILE', items:[{key:'키워드', position:2}] }
        return relay(res, await nv("POST", "/estimate/average-position-bid/keyword", { jsonBody: { device: body.device || "PC", items: body.items || [] } }));
      }

      case "stats": {
        // query: id, fields(JSON), timeRange(JSON) 또는 statType
        const sq = {};
        for (const k of ["id", "ids", "fields", "timeRange", "datePreset", "statType", "breakdown", "timeIncrement"]) {
          if (req.query[k] != null) sq[k] = req.query[k];
        }
        return relay(res, await nv("GET", "/stats", { rawQuery: q(sq) }));
      }

      // ── 대용량 보고서(StatReport): 생성→상태확인→다운로드 3단계 (클라이언트/크론이 오케스트레이션) ──
      case "report_create":
        // body: { reportTp:'EXPKEYWORD'|'AD'|'AD_DETAIL'..., statDt:'YYYY-MM-DD' }
        return relay(res, await nv("POST", "/stat-reports", { jsonBody: { reportTp: body.reportTp, statDt: body.statDt } }));
      case "report_status":
        return relay(res, await nv("GET", `/stat-reports/${req.query.id}`));
      case "report_delete":
        return relay(res, await nv("DELETE", `/stat-reports/${req.query.id}`));
      case "report_download": {
        // query: url = report_status가 준 downloadUrl. 경로만 서명해서 TSV 텍스트를 그대로 반환.
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "url required" });
        let u;
        try { u = new URL(url); } catch { return res.status(400).json({ error: "invalid url" }); }
        // SSRF 방어: 네이버 보고서 다운로드 호스트/경로로만 제한.
        if (u.hostname !== "api.searchad.naver.com" || !u.pathname.startsWith("/report-download")) {
          return res.status(400).json({ error: "url not allowed" });
        }
        const ts = Date.now().toString();
        const r = await fetch(url, { headers: {
          "X-Timestamp": ts, "X-API-KEY": API_KEY, "X-Customer": String(CUSTOMER_ID),
          "X-Signature": sign(SECRET_KEY, ts, "GET", u.pathname),
        }});
        const text = await r.text();
        return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, tsv: text });
      }

      // ── 제외키워드(파워링크 키워드확장 제외). 읽기 open, 추가/삭제는 게이트 ──
      case "get_restricted_keywords":
        return relay(res, await nv("GET", `/ncc/adgroups/${req.query.nccAdgroupId}/restricted-keywords`));
      case "add_restricted_keyword": {
        // body: { nccAdgroupId, keyword, type? }  type 기본 KEYWORD_PLUS_RESTRICT (파워링크 확장검색 제외)
        const { nccAdgroupId, keyword } = body;
        const type = body.type || "KEYWORD_PLUS_RESTRICT";
        if (!nccAdgroupId || !keyword) return res.status(400).json({ error: "nccAdgroupId, keyword required" });
        return relay(res, await nv("POST", `/ncc/adgroups/${nccAdgroupId}/restricted-keywords`, { jsonBody: [{ restrictedKeyword: String(keyword), type }] }));
      }
      case "delete_restricted_keyword": {
        // body: { nccAdgroupId, ids:[...] }
        const { nccAdgroupId, ids } = body;
        if (!nccAdgroupId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "nccAdgroupId, ids[] required" });
        return relay(res, await nv("DELETE", `/ncc/adgroups/${nccAdgroupId}/restricted-keywords`, { rawQuery: q({ ids: ids.join(",") }) }));
      }

      // ── 쓰기 (게이트 대상) ──
      case "update_ad_bid": {
        // body: { nccAdId, bidAmt }  — 쇼핑 소재 입찰가. 현재 소재를 읽어 필수필드 채운 뒤 adAttr만 변경.
        const { nccAdId, bidAmt } = body;
        const bid = validBid(bidAmt);
        if (!nccAdId || bid == null) return res.status(400).json({ error: "nccAdId required; bidAmt must be integer 10~100000" });
        const cur = await nv("GET", `/ncc/ads/${nccAdId}`);
        if (!cur.ok) return relay(res, cur);
        const a = cur.data;
        const put = await nv("PUT", `/ncc/ads/${nccAdId}`, {
          rawQuery: "?fields=adAttr", // ⚠️ 반복파라미터 형식 (JSON배열 아님)
          jsonBody: {
            nccAdId, nccAdgroupId: a.nccAdgroupId, type: a.type, ad: a.ad || {},
            adAttr: { ...a.adAttr, bidAmt: bid },
            userLock: a.userLock, enable: a.enable,
          },
        });
        return relay(res, put);
      }

      case "update_keyword_bid": {
        // body: { nccKeywordId, nccAdgroupId, bidAmt }  — 파워링크 키워드 입찰가.
        const { nccKeywordId, nccAdgroupId, bidAmt } = body;
        const kbid = validBid(bidAmt);
        if (!nccKeywordId || !nccAdgroupId || kbid == null) return res.status(400).json({ error: "nccKeywordId, nccAdgroupId required; bidAmt must be integer 10~100000" });
        const put = await nv("PUT", `/ncc/keywords/${nccKeywordId}`, {
          rawQuery: '?fields=["bidAmt"]', // ⚠️ 키워드는 JSON배열 형식
          jsonBody: { nccKeywordId, nccAdgroupId, bidAmt: kbid, useGroupBidAmt: false },
        });
        return relay(res, put);
      }

      default:
        return res.status(400).json({ error: `unknown action: ${action}` });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// 네이버 응답 상태/본문 그대로 중계
function relay(res, r) {
  return res.status(r.ok ? 200 : r.status).json(r.ok ? r.data : { error: "naver api error", status: r.status, detail: r.data });
}

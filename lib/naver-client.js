// lib/naver-client.js — 네이버 검색광고 "읽기 전용" 클라이언트 (수집 크론 전용, self-contained).
// api/naver.js(flagship 입찰 쓰기 경로) 및 auto-adjust.js 와 완전 분리 — 이 파일은 읽기만 한다.
// HMAC 서명 형식은 api/naver.js와 동일: base64(HMAC-SHA256(secret, "{ts}.{METHOD}.{path}")).
import crypto from "node:crypto";

const BASE = "https://api.searchad.naver.com";

function sign(secret, ts, method, path) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${method}.${path}`).digest("base64");
}

// env에서 자격증명을 받아 서명된 호출 헬퍼를 만든다.
export function makeNaver(env) {
  const CID = env.NAVER_CUSTOMER_ID, KEY = env.NAVER_API_KEY, SEC = env.NAVER_SECRET_KEY;
  if (!CID || !KEY || !SEC) throw new Error("NAVER_* credentials not configured");

  async function nv(method, path, { rawQuery = "", jsonBody } = {}) {
    const ts = Date.now().toString();
    const r = await fetch(BASE + path + rawQuery, {
      method,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Timestamp": ts, "X-API-KEY": KEY, "X-Customer": String(CID),
        "X-Signature": sign(SEC, ts, method, path),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new Error(`naver ${method} ${path} ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return data;
  }
  const q = (o) => "?" + new URLSearchParams(o).toString();

  // 보고서 다운로드: 경로만 서명해서 TSV 텍스트 반환. SSRF 방어(네이버 report-download 호스트/경로만).
  async function download(url) {
    let u; try { u = new URL(url); } catch { throw new Error("invalid url"); }
    if (u.hostname !== "api.searchad.naver.com" || !u.pathname.startsWith("/report-download")) throw new Error("url not allowed");
    const ts = Date.now().toString();
    const r = await fetch(url, { headers: {
      "X-Timestamp": ts, "X-API-KEY": KEY, "X-Customer": String(CID), "X-Signature": sign(SEC, ts, "GET", u.pathname),
    }});
    return await r.text();
  }

  return { nv, q, download };
}

const isRunning = (x) => x && x.status === "ELIGIBLE"; // 운영중(노출가능) — 프론트 naver.js와 동일 규칙

// 운영중 쇼핑 소재 전체 나열: 캠페인(SHOPPING·운영중)→그룹(운영중)→소재(userLock!=true).
// 프론트 renderBid()의 구조 순회와 동일. (쇼핑=검색광고 비용 ~90%라 수집 1차 대상)
export async function listRunningShoppingAds({ nv, q }) {
  const camps = (await nv("GET", "/ncc/campaigns")) || [];
  const shop = camps.filter(c => c.campaignTp === "SHOPPING" && isRunning(c));
  const perCamp = await Promise.all(shop.map(async c => {
    const groups = (await nv("GET", "/ncc/adgroups", { rawQuery: q({ nccCampaignId: c.nccCampaignId }) })) || [];
    const eg = groups.filter(isRunning);
    const withAds = await Promise.all(eg.map(async g => {
      const ads = (await nv("GET", "/ncc/ads", { rawQuery: q({ nccAdgroupId: g.nccAdgroupId }) })) || [];
      return ads.filter(a => a.userLock !== true).map(a => ({
        nccAdId: a.nccAdId, campaignId: c.nccCampaignId, campaignName: c.name,
        adgroupId: g.nccAdgroupId, adgroupName: g.name,
        bid: Number(a.adAttr && a.adAttr.bidAmt) || null,
      }));
    }));
    return withAds.flat();
  }));
  return perCamp.flat();
}

// /stats 배치(90개씩): id별 imp/clk/cost(salesAmt)/avg_rnk. since/until='YYYY-MM-DD'.
export async function statsBatch({ nv, q }, ids, since, until) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
  await Promise.all(chunks.map(async ch => {
    try {
      const r = await nv("GET", "/stats", { rawQuery: q({
        ids: ch.join(","),
        fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "avgRnk"]),
        timeRange: JSON.stringify({ since, until }),
      })});
      const rows = Array.isArray(r) ? r : (Array.isArray(r.data) ? r.data : []);
      rows.forEach(x => { map[x.id] = { imp: +x.impCnt || 0, clk: +x.clkCnt || 0, cost: +x.salesAmt || 0, rank: +x.avgRnk || 0 }; });
    } catch {}
  }));
  return map;
}

// AD_CONVERSION 보고서(statDt) → 소재별 직접구매 {cnt,val}. col10='purchase' AND col9='1'(직접)만.
// (장바구니·간접 제외 — 프론트 loadPurchase7d와 동일 규칙, "구매완료 직접전환"과 일치)
export async function dailyDirectConv(client, statDt) {
  const { nv, download } = client;
  const map = {};
  let id;
  try {
    const job = await nv("POST", "/stat-reports", { jsonBody: { reportTp: "AD_CONVERSION", statDt } });
    id = job.reportJobId || job.id;
    let url = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const st = await nv("GET", `/stat-reports/${id}`);
      if (st.status === "BUILT" || st.status === "DONE") { url = st.downloadUrl; break; }
      if (st.status === "NONE" || st.status === "DELETED") break;
    }
    if (url) {
      const tsv = await download(url);
      (tsv || "").split(/\r?\n/).forEach(ln => {
        const c = ln.split("\t");
        if (c[10] === "purchase" && c[9] === "1") {
          const m = (map[c[5]] ||= { cnt: 0, val: 0 });
          m.cnt += Number(c[11]) || 0;
          m.val += Number(c[12]) || 0;
        }
      });
    }
  } catch {}
  // 생성한 보고서 정리(실패 무시)
  if (id) { try { await nv("DELETE", `/stat-reports/${id}`); } catch {} }
  return map;
}

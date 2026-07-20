// api/naver-collect.js — 네이버 수집 크론(6시간 간격). 읽기전용 수집 + 예산급증/랜딩404 알림.
// ⚠️ 네이버에 쓰기 없음(돈 안 나감). auto-adjust.js·api/naver.js(입찰 쓰기)와 완전 분리.
// 스케줄러 = cron-job.org (auto-adjust와 동일 패턴): 헤더 x-cron-secret: <CRON_SECRET>.
//   권장 스케줄(KST): 09·15·21·03시 = "0 0,6,12,18 * * *" (UTC). 03시 슬롯에서 전일 완결(daily) 수집.
// 수동 점검: GET/POST /api/naver-collect  (헤더 x-cron-secret 필요)
import { makeNaver, listRunningShoppingAds, statsBatch, dailyDirectConv } from "../lib/naver-client.js";

export const config = { maxDuration: 60 };

const SB_URL = process.env.SUPABASE_URL || "https://baucagnqmtmaqlybjyzc.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...extra };
}
async function sbInsert(table, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: "POST", headers: sbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(rows.slice(i, i + 1000)),
    });
    if (!r.ok) throw new Error(`sb insert ${table} ${r.status}: ${await r.text()}`);
  }
}
async function sbSelect(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`sb select ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbCount(table, filter) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { headers: sbHeaders({ Prefer: "count=exact", Range: "0-0" }) });
  return Number((r.headers.get("content-range") || "*/0").split("/")[1]) || 0;
}

// KST 기준 now / n일 전 날짜
function kstNow() { const d = new Date(Date.now() + 9 * 3600 * 1000); return { hour: d.getUTCHours(), ymd: d.toISOString().slice(0, 10), dow: d.getUTCDay() }; }
const kstAgo = (n) => new Date(Date.now() - n * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const kstHourOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).getUTCHours();

async function gchatSend(text) {
  const hook = process.env.GCHAT_WEBHOOK;
  if (!hook) return false;
  try {
    const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  // 크론 인증(auto-adjust.js와 동일): x-cron-secret 헤더 or body.secret. CRON_SECRET 미설정 시 차단(fail-closed).
  const secret = req.headers["x-cron-secret"] || (req.body && req.body.secret);
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SB_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" });

  const now = kstNow();
  const today = now.ymd;
  const isDailyRun = now.hour < 6; // 03시 KST 슬롯 = 전일 완결(daily) 수집
  const summary = { at: new Date().toISOString(), kstHour: now.hour, ads: 0, spikeAlerts: 0, landingAlerts: 0, dailyConv: false };
  const alertLines = [];

  let client;
  try { client = makeNaver(process.env); } catch (e) { return res.status(500).json({ error: e.message }); }

  // ── ① 수집 ────────────────────────────────────────────────────────────────
  let ads;
  try { ads = await listRunningShoppingAds(client); } catch (e) { return res.status(502).json({ error: "naver list failed: " + e.message }); }
  summary.ads = ads.length;
  const ids = ads.map(a => a.nccAdId);
  const meta = Object.fromEntries(ads.map(a => [a.nccAdId, a]));

  // intraday: 오늘 누적
  const stats = await statsBatch(client, ids, today, today);
  await sbInsert("nv_stat_snapshots", ids.map(id => {
    const s = stats[id] || { imp: 0, clk: 0, cost: 0, rank: 0 }, m = meta[id];
    return { kind: "intraday", stat_dt: today, level: "ad", campaign_id: m.campaignId, adgroup_id: m.adgroupId, entity_id: id, imp: s.imp, clk: s.clk, cost: s.cost, avg_rnk: s.rank || null, conv_cnt: 0, conv_val: 0 };
  }));

  // daily: 전일 완결 + 직접구매(ROAS 프로파일 토대) — 하루 1회
  if (isDailyRun) {
    const y = kstAgo(1);
    const dstats = await statsBatch(client, ids, y, y);
    const conv = await dailyDirectConv(client, y);
    await sbInsert("nv_stat_snapshots", ids.map(id => {
      const s = dstats[id] || { imp: 0, clk: 0, cost: 0, rank: 0 }, cv = conv[id] || { cnt: 0, val: 0 }, m = meta[id];
      return { kind: "daily", stat_dt: y, level: "ad", campaign_id: m.campaignId, adgroup_id: m.adgroupId, entity_id: id, imp: s.imp, clk: s.clk, cost: s.cost, avg_rnk: s.rank || null, conv_cnt: cv.cnt, conv_val: cv.val };
    }));
    summary.dailyConv = true;
  }

  // ── ⑤-a 예산 급증: 캠페인별 오늘 누적 cost vs 최근 7일 같은 시간대(±1h) 평균 ──────────
  // 최소 3일 이력이 있어야 발동(자가 무장) → 첫 배포 후 ~3일부터 알림 시작.
  try {
    const todayByCamp = {};
    for (const id of ids) { const s = stats[id]; if (!s) continue; const c = meta[id].campaignId; todayByCamp[c] = (todayByCamp[c] || 0) + s.cost; }
    const since = kstAgo(7);
    const hist = await sbSelect("nv_stat_snapshots", `select=stat_dt,captured_at,campaign_id,cost&kind=eq.intraday&stat_dt=gte.${since}&stat_dt=lt.${today}`);
    const perDayCamp = {}; // "day|camp" → 그 시각 캠페인 누적 cost
    hist.forEach(r => { if (Math.abs(kstHourOf(r.captured_at) - now.hour) > 1) return; const k = r.stat_dt + "|" + r.campaign_id; perDayCamp[k] = (perDayCamp[k] || 0) + Number(r.cost); });
    const sumByCamp = {}, daysByCamp = {};
    for (const k in perDayCamp) { const [day, camp] = k.split("|"); sumByCamp[camp] = (sumByCamp[camp] || 0) + perDayCamp[k]; (daysByCamp[camp] ||= new Set()).add(day); }
    for (const camp in todayByCamp) {
      const days = daysByCamp[camp] ? daysByCamp[camp].size : 0;
      if (days < 3) continue;
      const avg = sumByCamp[camp] / days;
      if (avg > 0 && todayByCamp[camp] >= 3 * avg && todayByCamp[camp] > 10000) {
        const dup = await sbSelect("nv_alert_log", `select=id&kind=eq.budget_spike&ref=eq.${encodeURIComponent(camp)}&created_at=gte.${new Date(Date.now() - 86400000).toISOString()}`);
        if (dup.length) continue;
        const name = meta[Object.keys(meta).find(id => meta[id].campaignId === camp)]?.campaignName || camp;
        const ratio = (todayByCamp[camp] / avg).toFixed(1);
        alertLines.push(`⚠️ *예산 급증* '${name}' — 오늘 ${Math.round(todayByCamp[camp]).toLocaleString()}원 (평소 ${now.hour}시 ${Math.round(avg).toLocaleString()}원의 ${ratio}배)`);
        await sbInsert("nv_alert_log", [{ kind: "budget_spike", ref: camp, detail: { today: todayByCamp[camp], avg, hour: now.hour, ratio }, notified: !!process.env.GCHAT_WEBHOOK }]);
        summary.spikeAlerts++;
      }
    }
  } catch (e) { summary.spikeError = e.message; }

  // ── ⑤-b 랜딩 404/5xx: product_url URL 회전 스캔(1회 120개, 6시간 슬롯마다 이동) ──────
  // daily(03시) 실행은 수집이 무거우므로 스킵 — 나머지 3회로 커버.
  if (!isDailyRun) {
    try {
      const SLICE = 120;
      const total = await sbCount("product_url", "select=ez_name&url=not.is.null");
      if (total > 0) {
        const slots = Math.ceil(total / SLICE);
        const slot = Math.floor(Date.now() / (6 * 3600 * 1000)) % slots;
        const batch = await sbSelect("product_url", `select=ez_name,url&url=not.is.null&order=ez_name.asc&limit=${SLICE}&offset=${slot * SLICE}`);
        // SSRF 방어 + 신호 정확도: 자사몰(ozkiz.com) 랜딩만 점검. 내부/임의 호스트로의 요청 차단.
        const isOwnLanding = (url) => { try { const h = new URL(url).hostname; return h === "ozkiz.com" || h.endsWith(".ozkiz.com"); } catch { return false; } };
        const valid = batch.filter(u => u.url && /^https?:\/\//.test(u.url) && isOwnLanding(u.url));
        const bad = [];
        for (let i = 0; i < valid.length; i += 30) {
          const part = valid.slice(i, i + 30);
          const rs = await Promise.all(part.map(async u => {
            try {
              const c = new AbortController(); const t = setTimeout(() => c.abort(), 4000);
              const r = await fetch(u.url, { method: "GET", redirect: "follow", signal: c.signal });
              clearTimeout(t); return { u, status: r.status };
            } catch { return { u, status: 0 }; }
          }));
          rs.forEach(x => { if (x.status === 404 || x.status >= 500) bad.push(x); });
        }
        for (const x of bad) {
          const dup = await sbSelect("nv_alert_log", `select=id&kind=eq.landing_error&ref=eq.${encodeURIComponent(x.u.url)}&created_at=gte.${new Date(Date.now() - 86400000).toISOString()}`);
          if (dup.length) continue;
          alertLines.push(`🔗 *랜딩 오류(${x.status || "timeout"})* ${x.u.ez_name} — ${x.u.url}`);
          await sbInsert("nv_alert_log", [{ kind: "landing_error", ref: x.u.url, detail: { status: x.status, ez_name: x.u.ez_name }, notified: !!process.env.GCHAT_WEBHOOK }]);
          summary.landingAlerts++;
        }
      }
    } catch (e) { summary.landingError = e.message; }
  }

  // ── 알림 발송(구글챗) ──────────────────────────────────────────────────────
  if (alertLines.length) {
    const head = `*[네이버 광고 모니터]* ${today} ${String(now.hour).padStart(2, "0")}시 (KST)`;
    summary.notified = await gchatSend([head, ...alertLines].join("\n"));
  }

  return res.status(200).json({ ok: true, ...summary, alerts: alertLines });
}

// ── 광고비 자동 조정 엔드포인트 ─────────────────────────────────
// GitHub Actions에서 각 발동 시각마다 호출
// CRON_SECRET 환경변수로 보안 처리

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 보안: secret 키 검증
  const secret = req.headers['x-cron-secret'] || req.body?.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 스케줄러 = cron-job.org (2026-07-08 UA 추적으로 확인 — 운영시간 중 30분 간격 호출, CRON_SECRET 헤더 설정됨)

  const META_TOKEN = process.env.META_ACCESS_TOKEN_AD_AUTO || process.env.META_ACCESS_TOKEN;
  const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;
  const META_BASE  = 'https://graph.facebook.com/v21.0';

  // KST 현재 시각 (분)
  const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const nowMin = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const today  = kstNow.toISOString().split('T')[0];
  const timeLabel = `${kstNow.getUTCHours() < 12 ? '오전' : '오후'} ${String(kstNow.getUTCHours() > 12 ? kstNow.getUTCHours()-12 : kstNow.getUTCHours()).padStart(1)}:${String(kstNow.getUTCMinutes()).padStart(2,'0')}`;

  // ── 운영시간 가드 (KST 08:00~21:30 밖이면 무조건 미발동) ─────────
  // 스케줄러를 외부(Vercel Cron 등)로 옮기므로, 잘못된 호출·키 유출 시에도
  // 운영시간 밖에선 어떤 룰도 안 돌도록 코드 레벨에서 방어.
  // 모든 룰의 triggerMin(08:00~21:00)을 포함하고, 따라잡기 여유로 21:30까지 허용.
  const OPEN_MIN = 7 * 60;        // 07:00 (2026-07-09: r2 오전 7시 증액을 위해 08:00→07:00 확장. 07~08시엔 r2만 발동 시각 도달)
  const CLOSE_MIN = 21 * 60 + 30; // 21:30
  // 심야 브레이크 슬롯 (2026-07-09): r19(01:00)·r20(04:00) 전용 — 새벽 과소진 캡.
  // 슬롯 = 발동시각 + 30분 주기 호출 여유. 이 창 밖 심야는 기존대로 전면 차단.
  // 낮 규칙들은 triggerMin(08:00+)이 미래라 심야 슬롯에서 발동 불가, 심야 규칙들은
  // catch-up 창(150분)이 지나 낮에 발동 불가 — 슬롯과 창 계산만으로 상호 격리됨.
  const NIGHT_SLOTS = [[2 * 60, 3 * 60 + 30], [4 * 60, 5 * 60 + 30]]; // 02:00~03:30, 04:00~05:30
  const inNightSlot = NIGHT_SLOTS.some(([a, b]) => nowMin >= a && nowMin <= b);
  if ((nowMin < OPEN_MIN || nowMin > CLOSE_MIN) && !inNightSlot) {
    return res.status(200).json({
      message: `운영시간 외 미발동 (KST ${timeLabel})`,
      nowMin,
    });
  }

  // ── 예산 규칙 정의 ──────────────────────────────────────────────
  const BUDGET_RULES = [
    {
      // OFF 규칙은 배열 맨 앞 — 광고당 첫 매칭 규칙만 적용되므로 OFF가 예산 조정보다 우선.
      // 예산 ₩20,000 이상 제외: 성과가 있어 증액됐던 광고가 최근 3일 이상치로 꺼지는 것 방지(사용자 지정 가드).
      // 08:00 = 운영시간 시작(가장 이른 발동 가능 시각). 심야(예: 01:00)는 운영시간 가드·스케줄러 미호출로 불가.
      id: 'r18', triggerMin: 8*60, dir: 'off',
      label: '오전 8:00 · 최근 3일(전일까지) 소진 ≥₩25,000 + 구매 0 → 광고 OFF (현재 예산 ₩20,000 이상이면 제외)',
      // ad.purchases === 0: 오늘 아침 막 구매가 발생한 광고는 살림 (3일 창엔 오늘이 빠지므로 별도 확인)
      check: (ad) => ad.spend3d >= 25000 && ad.purchases3d === 0 && ad.purchases === 0 && ad.budget < 20000,
      calc:  () => 0,
    },
    {
      // 심야 브레이크 1차 (2026-07-09): 저녁 수동 대폭 증액 → 새벽 과소진 사고 방지 (7/8 사례: 예산 2.1배 증액 후 새벽 62만 소진·ROAS 80%).
      // 예산 ≥20만 게이트 = 대형 예산만 대상(소형은 손실 상한이 작음). 소진 게이트 4만 = 정상 새벽 페이스(예산의 ~13%)는 통과, 폭주만 포착.
      // 컷 = 구매전환값의 100% → 죽이는 게 아니라 "번 만큼의 페이스"로 제한. 방향 가드 내장(트림 전용).
      id: 'r19', triggerMin: 2*60, dir: 'dn',
      label: '새벽 2:00 · 예산 ≥₩200,000 + 오늘 소진 ≥₩40,000 + ROAS ≤100% → 구매전환값의 100% (최소 ₩10,000)',
      check: (ad) => ad.budget >= 200000 && ad.spend >= 40000 && ad.roas <= 100 && ad.budget > Math.max(Math.round(ad.purchaseValue / 1000) * 1000, 10000),
      calc:  (ad) => Math.max(Math.round(ad.purchaseValue / 1000) * 1000, 10000),
    },
    {
      // 심야 브레이크 2차: 2시에 놓친(ROAS >100%였거나 이후 폭주) 재점검. 소진 게이트 6만 = 4시 정상 페이스(예산의 ~17%) 초과분만.
      // ROAS ≥200% 제외 = 구매 1건이 고액이라 명백히 벌고 있는 소재 보호(표본부족 오폭 방지).
      id: 'r20', triggerMin: 4*60, dir: 'dn',
      label: '새벽 4:00 · 예산 ≥₩200,000 + 오늘 소진 ≥₩60,000 + 구매 2건 미만 → 기존 예산의 50% (ROAS ≥200% 제외)',
      check: (ad) => ad.budget >= 200000 && ad.spend >= 60000 && ad.purchases < 2 && ad.roas < 200,
      calc:  (ad) => Math.round(ad.budget * 0.5 / 1000) * 1000,
    },
    {
      id: 'r1', triggerMin: 8*60, dir: 'dn',
      label: '오전 8:00 · 장바구니 ≤2 + ROAS ≤150% → ₩20,000',
      check: (ad) => ad.cart <= 2 && ad.roas <= 150 && ad.roas > 0,
      calc:  (ad) => ad.budget > 20000 ? 20000 : ad.budget,
    },
    {
      id: 'r2', triggerMin: 7*60, dir: 'up',
      label: '오전 7:00 · 장바구니 ≥5 → ₩30,000',
      check: (ad) => ad.cart >= 5 && ad.budget < 30000 && ad.roas <= 200,
      calc:  (ad) => 30000,
    },
    {
      id: 'r3', triggerMin: 7*60+10, dir: 'up',
      label: '오전 7:10 · ROAS ≥300% → 구매전환값의 100%',
      check: (ad) => ad.roas >= 300 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue / 1000) * 1000,
    },
    {
      id: 'r3b', triggerMin: 8*60+20, dir: 'up',
      label: '오전 8:20 · 구매 ≥2 + ROAS ≥250% → 구매전환값의 120%',
      check: (ad) => ad.purchases >= 2 && ad.roas >= 250 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue * 1.2 / 1000) * 1000,
    },
    {
      id: 'r4a', triggerMin: 9*60+50, dir: 'up',
      label: '오전 9:50 · 구매 ≥2 + ROAS ≥300% → 현재예산 +20%',
      check: (ad) => ad.purchases >= 2 && ad.roas >= 300 && ad.roas < 500,
      calc:  (ad) => Math.round(ad.budget * 1.2 / 1000) * 1000,
    },
    {
      id: 'r4b', triggerMin: 9*60+50, dir: 'up',
      label: '오전 9:50 · 구매 ≥2 + ROAS ≥500% → 현재예산 +30%',
      check: (ad) => ad.purchases >= 2 && ad.roas >= 500 && ad.roas < 700,
      calc:  (ad) => Math.round(ad.budget * 1.3 / 1000) * 1000,
    },
    {
      id: 'r4c', triggerMin: 9*60+50, dir: 'up',
      label: '오전 9:50 · 구매 ≥2 + ROAS ≥700% → 현재예산 +40%',
      check: (ad) => ad.purchases >= 2 && ad.roas >= 700,
      calc:  (ad) => Math.round(ad.budget * 1.4 / 1000) * 1000,
    },
    {
      id: 'r5', triggerMin: 10*60, dir: 'up',
      label: '오전 10:00 · 구매 1건 + ROAS ≥300% → 구매전환값의 100%',
      check: (ad) => ad.purchases >= 1 && ad.purchases < 2 && ad.roas >= 300 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue / 1000) * 1000,
    },
    {
      id: 'r6', triggerMin: 10*60+10, dir: 'dn',
      label: '오전 10:10 · 장바구니 0 + ROAS ≤150% → ₩15,000',
      check: (ad) => ad.cart === 0 && ad.roas <= 150 && ad.roas > 0,
      calc:  (ad) => ad.budget > 15000 ? 15000 : ad.budget,
    },
    {
      id: 'r7', triggerMin: 12*60, dir: 'dn',
      label: '오후 12:00 · ROAS ≤100% → 구매전환값의 60%',
      check: (ad) => ad.roas <= 100 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.6 / 1000) * 1000,
    },
    {
      id: 'r7b', triggerMin: 11*60+50, dir: 'dn',
      label: '오전 11:50 · ROAS ≤150% → 구매전환값의 90%',
      check: (ad) => ad.roas > 100 && ad.roas <= 150 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.9 / 1000) * 1000,
    },
    {
      id: 'r7c', triggerMin: 14*60+50, dir: 'dn',
      label: '오후 2:50 · 구매전환값 0 → ₩10,000',
      check: (ad) => ad.purchaseValue === 0 && ad.budget > 10000,
      calc:  (ad) => 10000,
    },
    {
      id: 'r8', triggerMin: 12*60+10, dir: 'up',
      label: '오후 12:10 · ROAS ≥300% → 구매전환값의 120%',
      check: (ad) => ad.roas >= 300 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue * 1.2 / 1000) * 1000,
    },
    {
      id: 'r9', triggerMin: 12*60+30, dir: 'up',
      label: '오후 12:30 · 예산 ≤5000 + ROAS ≥300% → 구매전환값의 40%',
      check: (ad) => ad.budget <= 5000 && ad.roas >= 300 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.4 / 1000) * 1000,
    },
    {
      id: 'r10', triggerMin: 15*60, dir: 'dn',
      label: '오후 3:00 · ROAS ≤200% → 구매전환값의 50%',
      check: (ad) => ad.roas <= 200 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
    },
    {
      id: 'r11', triggerMin: 15*60+10, dir: 'up',
      label: '오후 3:10 · ROAS ≥300% → 구매전환값의 100%',
      check: (ad) => ad.roas >= 300 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue / 1000) * 1000,
    },
    {
      id: 'r12', triggerMin: 18*60, dir: 'dn',
      label: '오후 6:00 · ROAS ≤200% → 구매전환값의 30%',
      check: (ad) => ad.roas <= 200 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.3 / 1000) * 1000,
    },
    {
      id: 'r13', triggerMin: 18*60, dir: 'dn',
      label: '오후 6:00 · ROAS 0% → ₩10,000',
      check: (ad) => ad.roas === 0,
      calc:  (ad) => ad.budget > 10000 ? 10000 : ad.budget,
    },
    {
      id: 'r14', triggerMin: 18*60+5, dir: 'up',
      label: '오후 6:05 · ROAS ≥400% → 구매전환값의 60%',
      // budget≤pv 가드 제거: 허수 예산이 매출액보다 큰 과지출 상태(가장 위험)에서도 발동해 예산을 조이도록.
      check: (ad) => ad.roas >= 400 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.6 / 1000) * 1000,
    },
    {
      id: 'r15', triggerMin: 18*60+10, dir: 'up',
      label: '오후 6:10 · ROAS ≥300% → 구매전환값의 50%',
      // budget≤pv 가드 제거: 허수 예산이 매출액보다 큰 과지출 상태(가장 위험)에서도 발동해 예산을 조이도록.
      check: (ad) => ad.roas >= 300 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
    },
    {
      id: 'r16', triggerMin: 21*60, dir: 'dn',
      label: '오후 9:00 · ROAS ≤200% → 구매전환값의 50%',
      check: (ad) => ad.roas <= 200 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
    },
    {
      id: 'r17', triggerMin: 16*60, dir: 'dn',
      label: '오후 4:00 · ROAS 150~200% → 구매전환값의 40%',
      // 방향 가드 내장: 계산값(구매전환값×0.4)이 현재 예산보다 작을 때만 발동(트림 전용)
      check: (ad) => ad.roas >= 150 && ad.roas < 200 && ad.purchaseValue > 0 && ad.budget > Math.round(ad.purchaseValue * 0.4 / 1000) * 1000,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.4 / 1000) * 1000,
    },
  ];

  const SB_URL = process.env.SUPABASE_URL || 'https://baucagnqmtmaqlybjyzc.supabase.co';
  // 서버 전용 service role 키로 통일 — RLS를 우회하므로 읽기(오늘 실행기록 dedup)·
  // 쓰기(budget_rule_logs insert) 모두 RLS 정책 영향 없이 동작.
  // ⚠️ 이 키는 auto-adjust(Vercel 서버) 전용. 하드코딩 금지, 브라우저(index.html 등)엔 절대 노출 금지(거긴 anon 유지).
  // anon 폴백 없음: 폴백이 타면 insert가 RLS(42501)로 실패 → dedup 무력화 → 예산 왕복이 조용히 재발할 수 있음.
  // 키가 없으면 SB_KEY=undefined → 아래 sbHeaders=null → 기존 fail-safe(예산 조정 미발동)로 멈추는 게 안전.
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_KEY) {
    console.warn('SUPABASE_SERVICE_ROLE_KEY 없음 → 안전상 미발동(sbHeaders=null, 예산 조정 안 함).');
  }
  const sbHeaders = SB_KEY ? {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  } : null;

  // Supabase에서 규칙 커스터마이즈 불러오기 (trigger_min, disabled)
  if (sbHeaders) {
    try {
      const rulesRes = await fetch(`${SB_URL}/rest/v1/budget_rules?select=id,trigger_min,disabled`, { headers: sbHeaders });
      const rulesData = await rulesRes.json();
      if (Array.isArray(rulesData)) {
        rulesData.forEach(r => {
          const rule = BUDGET_RULES.find(br => br.id === r.id);
          if (rule) {
            if (r.trigger_min !== null) rule.triggerMin = r.trigger_min;
            if (r.disabled !== null) rule.disabled = r.disabled;
          }
        });
      }
    } catch(e) { console.log('규칙 Supabase 로드 실패:', e); }
  }

  // ── catch-up 발동 판정 (광고세트별 복합 dedup) ───────────────────
  // GitHub cron이 수십 분 지연 도착해도 룰을 놓치지 않도록,
  // "현재 ±5분"이 아니라 "오늘(KST) triggerMin이 이미 지난 룰"을 후보로 두고,
  // 실제 중복 방지는 루프 안에서 (rule_id + adset_id) 복합키로 처리한다.
  // → 같은 룰이라도 광고(adset)가 다르면 각각 발동, 같은 광고+같은 룰은 하루 1회.

  // 오늘(KST) 자정에 해당하는 UTC 시각 → executed_at 필터 기준
  const kstMidnightUtc = new Date(`${today}T00:00:00+09:00`).toISOString();

  // 오늘 이미 실행(기록)된 `${rule_id}__${adset_id}` 복합키 집합. null = 조회 실패(=불확실)
  let executedToday = null;
  if (sbHeaders) {
    try {
      const logUrl = `${SB_URL}/rest/v1/budget_rule_logs` +
        `?select=rule_id,adset_id,ad_name&executed_at=gte.${encodeURIComponent(kstMidnightUtc)}`;
      const logRes = await fetch(logUrl, {
        headers: { ...sbHeaders, 'Range-Unit': 'items', 'Range': '0-9999' },
      });
      if (logRes.ok) {
        const logRows = await logRes.json();
        executedToday = new Set((Array.isArray(logRows) ? logRows : []).map(x => {
          // adset_id 없으면(과거 행) ad_name으로 폴백 — 키 생성이 깨지지 않게 방어
          const target = (x.adset_id !== null && x.adset_id !== undefined && x.adset_id !== '')
            ? x.adset_id : (x.ad_name || '');
          return `${x.rule_id}__${target}`;
        }));
      }
    } catch (e) { console.log('오늘 실행기록 조회 실패:', e); }
  }

  // 안전장치(READ 실패 fail-safe): 오늘 실행기록을 못 읽으면 발동하지 않는다.
  // %증액 룰(r4a/b/c)은 중복 발동 시 예산이 복리로 늘어나므로,
  // '못 읽으면 멈춘다'가 '모르고 또 올린다'보다 안전.
  if (executedToday === null) {
    return res.status(200).json({
      message: `오늘 실행기록 조회 불가 → 안전상 미발동 (KST ${timeLabel})`,
      nowMin,
    });
  }

  // 발동 후보: 비활성 아님 + 오늘 triggerMin 지남 + 지난 지 따라잡기 창(분) 이내.
  // 광고세트별 중복 방지는 루프 안 복합키 체크에서 수행.
  //
  // [근거] GitHub Actions가 */15 예약 호출의 70~80%를 드롭 → 실측 운영시간 최대 공백 278분,
  //   저녁 룰이 trigger보다 +99~109분 늦게 도착(2026-06-09). 기존 60분 창은 룰의 57%를 놓침.
  //
  // [방향별 차등 창] cron 지연은 흡수하되, 몇 시간 전 룰을 지금 데이터로 소환하진 않도록 제한:
  //   - 감액(dir:'dn') 150분 — 늦게 발동해도 "지금도 ROAS 낮으면 깎기"라 안전. 92% 커버.
  //   - 증액(dir:'up')  75분 — 과거 시각에 좋았던 걸 지금 키우는 위험을 줄이려 보수적으로 짧게.
  //                            (복리 증액 r4a/b/c는 복합키 dedup이 중복 발동 자체는 막아줌)
  const CATCHUP_DN = 150;  // 감액 따라잡기 창(분)
  const CATCHUP_UP = 75;   // 증액 따라잡기 창(분)
  const activeRules = BUDGET_RULES.filter(r => {
    if (r.disabled || r.triggerMin > nowMin) return false;
    const win = r.dir === 'up' ? CATCHUP_UP : CATCHUP_DN;
    return (nowMin - r.triggerMin) <= win;
  });

  if (!activeRules.length) {
    return res.status(200).json({
      message: `발동 후보 룰 없음 (KST ${timeLabel})`,
      nowMin,
    });
  }

  try {
    // 오늘 광고 데이터 조회
    const fields = [
      'id', 'name', 'status', 'effective_status', 'daily_budget',
      'adset{id,name,daily_budget}',
      `insights.time_range({"since":"${today}","until":"${today}"})` +
      `{spend,purchase_roas,impressions,actions,action_values}`,
    ].join(',');

    // ACTIVE 서버필터 + paging.next 끝까지(계정 광고 4000개+ 중 200개만 조정되던 버그 수정)
    let _url =
      `${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&effective_status=${encodeURIComponent(JSON.stringify(['ACTIVE']))}` +
      `&limit=200`;
    const _all = [];
    let _guard = 0;
    while (_url && _guard < 20) {
      const r = await fetch(_url);
      const data = await r.json();
      if (data.error) throw new Error(data.error.message);
      if (Array.isArray(data.data)) _all.push(...data.data);
      _url = data.paging?.next || null;
      _guard++;
    }
    const ads = _all.filter(ad => ad.effective_status === 'ACTIVE'); // 이중 안전장치

    const getAction = (actions, type) => {
      const a = (actions || []).find(a => a.action_type === type);
      return a ? parseFloat(a.value) : 0;
    };

    // ── r18 OFF 판정용: 최근 3일(전일까지) 광고별 누적 소진·구매 ──
    // 별도 호출 + 실패 격리: 이 조회가 실패해도 stats3d={} → r18만 미발동, 다른 규칙 무영향.
    const since3 = new Date(kstNow.getTime() - 3 * 86400000).toISOString().split('T')[0];
    const until3 = new Date(kstNow.getTime() - 1 * 86400000).toISOString().split('T')[0];
    let stats3d = {};
    try {
      let u3 = `${META_BASE}/${AD_ACCOUNT}/insights?access_token=${META_TOKEN}` +
        `&level=ad&fields=${encodeURIComponent('ad_id,spend,actions')}` +
        `&time_range=${encodeURIComponent(JSON.stringify({ since: since3, until: until3 }))}&limit=500`;
      let g3 = 0;
      while (u3 && g3 < 20) {
        const r3 = await fetch(u3);
        const d3 = await r3.json();
        if (d3.error) throw new Error(d3.error.message);
        (d3.data || []).forEach(row => {
          stats3d[row.ad_id] = { spend3d: parseFloat(row.spend || 0), purchases3d: getAction(row.actions, 'purchase') };
        });
        u3 = d3.paging?.next || null;
        g3++;
      }
    } catch (e) { console.log('3일 인사이트 조회 실패 → r18 미발동:', e.message); stats3d = {}; }

    // ── (기록 전용) 목표 ROAS 밴드 & 발동 시점 판정 헬퍼 ───────────
    // 예산 조정 로직과 무관. 기록용 verdict/verdict_reason 생성에만 사용.
    // ROAS는 룰의 check가 쓰는 roas 변수(purchase_roas 기반)와 동일값을 받는다.
    const TARGET_LOW = 250, TARGET_HIGH = 300, FAR_BELOW = 150;
    const MIN_PURCHASES = 2; // 표본 신뢰 최소 구매 건수(2건 미만이면 ROAS 신뢰 불가)
    const judgeVerdict = (roas, oldB, newB, purchases) => {
      const r2 = Math.round(roas);
      // 표본부족 가드: 구매 2건 미만이면 ROAS가 1건의 우연에 좌우돼 신뢰 불가.
      // ROAS 기반 판정(기회손실/과잉증액/과소감액/정상)을 전부 건너뛰고 판정 보류.
      // 예) 구매 1건·ROAS 385% → 룰의 보수적 감액이 합리적인데 기존엔 "기회손실"로 오판했음.
      if (purchases < MIN_PURCHASES) {
        return ['표본부족', `구매 ${purchases}건, ROAS ${r2}%는 표본 부족으로 판정 보류`];
      }
      const up = newB > oldB, dn = newB < oldB;
      const pct = oldB > 0 ? Math.round((newB - oldB) / oldB * 100) : 0;
      const pctStr = (pct >= 0 ? '+' : '') + pct + '%';
      // ROAS 목표 초과인데 증액 안 함(감액/유지) → 기회손실
      if (roas > TARGET_HIGH && !up) {
        return ['기회손실', `ROAS ${r2}%(목표 ${TARGET_HIGH}% 초과)인데 ${dn ? `${pctStr} 감액` : '예산 유지'}`];
      }
      // ROAS 목표 미만인데 증액 → 과잉증액
      if (roas < TARGET_LOW && up) {
        return ['과잉증액', `ROAS ${r2}%(목표 ${TARGET_LOW}% 미만)인데 ${pctStr} 증액`];
      }
      // ROAS 한참 미만(<150%)인데 안 줄이거나 10% 미만 찔끔 감액 → 과소감액
      if (roas < FAR_BELOW && (!dn || newB > oldB * 0.9)) {
        return ['과소감액', `ROAS ${r2}%(${FAR_BELOW}% 한참 미만)인데 ${dn ? `${pctStr} 소폭 감액` : '감액 안 함'}`];
      }
      // 그 외 의도 부합
      return ['정상', `ROAS ${r2}% · ${pctStr} (${up ? '증액' : dn ? '감액' : '유지'}) 의도 부합`];
    };

    // 규칙 적용
    const results = [];
    const updatedAdsets = new Set();

    for (const ad of ads) {
      const ins = (ad.insights?.data || [{}])[0];
      const roasData = ins.purchase_roas || [];
      const roas = roasData[0] ? Math.round(parseFloat(roasData[0].value) * 100) : 0;
      const spend = parseFloat(ins.spend || 0);
      const actions = ins.actions || [];
      const actionValues = ins.action_values || [];
      const cart = Math.round(getAction(actions, 'add_to_cart'));
      const purchases = getAction(actions, 'purchase');
      const purchaseValue = getAction(actionValues, 'purchase');
      const budget = parseInt(ad.adset?.daily_budget || ad.daily_budget || 0);
      const adsetId = ad.adset?.id;

      // r18 OFF 판정용: 최근 3일(전일까지) 누적. 조회 실패·기록 없음 → 0 → check false(안전 미발동)
      const s3 = stats3d[ad.id] || {};
      const spend3d = s3.spend3d || 0;
      const purchases3d = s3.purchases3d ?? 0;

      const adData = { roas, budget, cart, purchases, purchaseValue, spend, spend3d, purchases3d };

      // 카테고리 광고도 규칙 대상 (2026-07-08 스킵 제거 — 근거 없는 초기 구현 잔재.
      // 프론트 수동 실행과 동일 동작. 카테고리 광고의 '재고 기반 품절 OFF' 제외는 프론트에서 원래대로 유지)
      const productName = (ad.name || '').split(';')[0].trim();

      // 예산 0 스킵: CBO(캠페인 예산 관리) 광고세트는 daily_budget이 없어 0으로 읽힘.
      // 0원이 최소클램프(1,000원)로 둔갑해 Meta가 거부 → r13 등에서 매일 무의미한 실패가 쌓였음(릴레이특가 168건).
      if (!budget) continue;

      for (const rule of activeRules) {
        if (!rule.check(adData)) continue;
        const isOff = rule.dir === 'off';
        const newBudget = isOff ? 0 : Math.max(rule.calc(adData), 1000);
        if (!isOff) {
          if (newBudget === budget) continue;
          // 미세 조정 스킵(전역 가드, 2026-07-08): 증감 폭 13% 미만은 성과 영향 없이
          // 광고세트 수정 이벤트(머신러닝 재학습 위험)만 만들므로 발동 안 함. (최근 2주 기준 전체 조정의 6%만 해당)
          if (Math.abs(newBudget - budget) / budget < 0.13) continue;
          // r10·r12·r16 감액 방향 가드: 감액 규칙인데 계산값이 현재 예산 이상(증액/동일)이면 발동 안 함.
          // (ROAS 100~200% 등에서 구매전환값 50%가 현재 예산보다 커 오히려 증액되던 문제 차단)
          if ((rule.id === 'r10' || rule.id === 'r12' || rule.id === 'r16') && newBudget >= budget) continue;
        }

        const targetId = adsetId || ad.id;
        // (catch-up 복합 dedup) 그 광고(adset)에 그 룰이 오늘 이미 돌았으면 건너뜀
        if (executedToday.has(`${rule.id}__${targetId}`)) continue;
        if (updatedAdsets.has(targetId)) continue;
        updatedAdsets.add(targetId);

        // 실행: OFF 규칙은 광고 자체를 PAUSED(수동 실행의 품절 OFF와 동일 레벨), 나머지는 광고세트 예산 변경
        const updateRes = await fetch(`${META_BASE}/${isOff ? ad.id : targetId}?access_token=${META_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isOff ? { status: 'PAUSED' } : { daily_budget: newBudget }),
        });
        const updateData = await updateRes.json();

        // ── (기록 전용) 발동 시점 스냅샷 + 판정 ──────────────────
        // ROAS는 룰의 check가 본 roas 변수를 그대로 사용 → 룰이 본 값 = 기록값 = 판정근거 일치.
        // 실패해도 예산 조정/루프에 영향 없도록 try/catch로 감쌈.
        let snap = {};
        try {
          const [verdict, verdictReason] = judgeVerdict(roas, budget, newBudget, purchases);
          snap = {
            adsetId: adsetId || null,
            adsetName: ad.adset?.name || null,
            spendAtTrigger: spend,
            valueAtTrigger: purchaseValue,
            roasAtTrigger: roas,
            verdict,
            verdictReason,
          };
        } catch (e) { console.log('판정 계산 실패:', e); }

        results.push({
          adName: productName,
          ruleId: rule.id,
          ruleLabel: rule.label,
          oldBudget: budget,
          newBudget,
          success: !updateData.error,
          error: updateData.error?.message,
          ...snap,
        });
        break;
      }
    }

    // Supabase에 실행 로그 저장
    if (sbHeaders && results.length) {
      const executedAt = new Date().toISOString();
      const logs = results.map(r => ({
        rule_id: r.ruleId,
        rule_label: r.ruleLabel,
        ad_name: r.adName,
        adset_id: r.adsetId ?? null,
        adset_name: r.adsetName ?? null,
        old_budget: r.oldBudget,
        new_budget: r.newBudget,
        success: r.success,
        executed_at: executedAt,
        spend_at_trigger: r.spendAtTrigger ?? null,
        value_at_trigger: r.valueAtTrigger ?? null,
        roas_at_trigger: r.roasAtTrigger ?? null,
        verdict: r.verdict ?? null,
        verdict_reason: r.verdictReason ?? null,
      }));
      try {
        const logRes = await fetch(`${SB_URL}/rest/v1/budget_rule_logs`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify(logs),
        });
        // ⚠️ fetch는 4xx/5xx에도 reject하지 않는다. 반드시 response.ok를 직접 확인할 것.
        //    (이 검사가 빠져 있어 RLS 42501 거부가 조용히 통과돼 로그가 0행이었음.)
        if (logRes.ok) {
          console.log(`budget_rule_logs 저장 성공: ${logs.length}건`);
        } else {
          const errBody = await logRes.text();
          console.error(`budget_rule_logs 저장 실패: ${logRes.status} ${logRes.statusText} — ${errBody}`);
        }
      } catch(e) { console.error('budget_rule_logs 저장 예외:', e); }
    }

    return res.status(200).json({
      time: timeLabel,
      activeRules: activeRules.map(r => r.label),
      results,
      changed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

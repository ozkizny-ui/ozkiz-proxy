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

  const META_TOKEN = process.env.META_ACCESS_TOKEN;
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
  const OPEN_MIN = 8 * 60;        // 08:00
  const CLOSE_MIN = 21 * 60 + 30; // 21:30
  if (nowMin < OPEN_MIN || nowMin > CLOSE_MIN) {
    return res.status(200).json({
      message: `운영시간 외 미발동 (KST ${timeLabel})`,
      nowMin,
    });
  }

  // ── 예산 규칙 정의 ──────────────────────────────────────────────
  const BUDGET_RULES = [
    {
      id: 'r1', triggerMin: 8*60, dir: 'dn',
      label: '오전 8:00 · 장바구니 ≤2 + ROAS ≤150% → ₩20,000',
      check: (ad) => ad.cart <= 2 && ad.roas <= 150 && ad.roas > 0,
      calc:  (ad) => ad.budget > 20000 ? 20000 : ad.budget,
    },
    {
      id: 'r2', triggerMin: 8*60, dir: 'up',
      label: '오전 8:00 · 장바구니 ≥5 → ₩30,000',
      check: (ad) => ad.cart >= 5 && ad.budget < 30000 && ad.roas <= 200,
      calc:  (ad) => 30000,
    },
    {
      id: 'r3', triggerMin: 8*60+10, dir: 'up',
      label: '오전 8:10 · ROAS ≥300% → 구매전환값의 100%',
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
      label: '오후 3:00 · ROAS ≤100% → 구매전환값의 50%',
      check: (ad) => ad.roas <= 100 && ad.roas > 0 && ad.purchaseValue > 0,
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
      label: '오후 6:00 · ROAS ≤100% → 구매전환값의 50%',
      check: (ad) => ad.roas <= 100 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
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
      check: (ad) => ad.roas >= 400 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.6 / 1000) * 1000,
    },
    {
      id: 'r15', triggerMin: 18*60+10, dir: 'up',
      label: '오후 6:10 · ROAS ≥300% → 구매전환값의 50%',
      check: (ad) => ad.roas >= 300 && ad.purchaseValue > 0 && ad.budget <= ad.purchaseValue,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
    },
    {
      id: 'r16', triggerMin: 21*60, dir: 'dn',
      label: '오후 9:00 · ROAS ≤200% → 구매전환값의 50%',
      check: (ad) => ad.roas <= 200 && ad.roas > 0 && ad.purchaseValue > 0,
      calc:  (ad) => Math.round(ad.purchaseValue * 0.5 / 1000) * 1000,
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

    const r = await fetch(
      `${META_BASE}/${AD_ACCOUNT}/ads?access_token=${META_TOKEN}` +
      `&fields=${encodeURIComponent(fields)}&limit=200`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);

    const ads = (data.data || []).filter(ad => ad.effective_status === 'ACTIVE');

    const getAction = (actions, type) => {
      const a = (actions || []).find(a => a.action_type === type);
      return a ? parseFloat(a.value) : 0;
    };

    // ── (기록 전용) 목표 ROAS 밴드 & 발동 시점 판정 헬퍼 ───────────
    // 예산 조정 로직과 무관. 기록용 verdict/verdict_reason 생성에만 사용.
    // ROAS는 룰의 check가 쓰는 roas 변수(purchase_roas 기반)와 동일값을 받는다.
    const TARGET_LOW = 250, TARGET_HIGH = 300, FAR_BELOW = 150;
    const judgeVerdict = (roas, oldB, newB) => {
      const up = newB > oldB, dn = newB < oldB;
      const r2 = Math.round(roas);
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

      const adData = { roas, budget, cart, purchases, purchaseValue, spend };

      // 카테고리 광고 스킵
      const productName = (ad.name || '').split(';')[0].trim();
      if (productName.includes('카테고리')) continue;

      for (const rule of activeRules) {
        if (!rule.check(adData)) continue;
        const newBudget = Math.max(rule.calc(adData), 1000);
        if (newBudget === budget) continue;

        const targetId = adsetId || ad.id;
        // (catch-up 복합 dedup) 그 광고(adset)에 그 룰이 오늘 이미 돌았으면 건너뜀
        if (executedToday.has(`${rule.id}__${targetId}`)) continue;
        if (updatedAdsets.has(targetId)) continue;
        updatedAdsets.add(targetId);

        // 예산 변경 실행
        const updateRes = await fetch(`${META_BASE}/${targetId}?access_token=${META_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily_budget: newBudget }),
        });
        const updateData = await updateRes.json();

        // ── (기록 전용) 발동 시점 스냅샷 + 판정 ──────────────────
        // ROAS는 룰의 check가 본 roas 변수를 그대로 사용 → 룰이 본 값 = 기록값 = 판정근거 일치.
        // 실패해도 예산 조정/루프에 영향 없도록 try/catch로 감쌈.
        let snap = {};
        try {
          const [verdict, verdictReason] = judgeVerdict(roas, budget, newBudget);
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

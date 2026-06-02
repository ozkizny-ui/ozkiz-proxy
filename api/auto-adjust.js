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
  const SB_KEY = process.env.SUPABASE_ANON_KEY;
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

  // 현재 시각 기준 발동할 규칙 (±5분 이내, 비활성 제외)
  const WINDOW = 5;
  const activeRules = BUDGET_RULES.filter(r =>
    !r.disabled && Math.abs(r.triggerMin - nowMin) <= WINDOW
  );

  if (!activeRules.length) {
    return res.status(200).json({
      message: `발동 규칙 없음 (KST ${timeLabel})`,
      nowMin,
    });
  }

  try {
    // 오늘 광고 데이터 조회
    const fields = [
      'id', 'name', 'status', 'effective_status', 'daily_budget',
      'adset{id,daily_budget}',
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
        if (updatedAdsets.has(targetId)) continue;
        updatedAdsets.add(targetId);

        // 예산 변경 실행
        const updateRes = await fetch(`${META_BASE}/${targetId}?access_token=${META_TOKEN}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily_budget: newBudget }),
        });
        const updateData = await updateRes.json();

        results.push({
          adName: productName,
          ruleId: rule.id,
          ruleLabel: rule.label,
          oldBudget: budget,
          newBudget,
          success: !updateData.error,
          error: updateData.error?.message,
        });
        break;
      }
    }

    // Supabase에 실행 로그 저장
    if (sbHeaders && results.length) {
      const logs = results.map(r => ({
        rule_id: r.ruleId,
        rule_label: r.ruleLabel,
        ad_name: r.adName,
        old_budget: r.oldBudget,
        new_budget: r.newBudget,
        success: r.success,
      }));
      try {
        await fetch(`${SB_URL}/rest/v1/budget_rule_logs`, {
          method: 'POST',
          headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify(logs),
        });
      } catch(e) { console.log('로그 저장 실패:', e); }
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

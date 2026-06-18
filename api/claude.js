export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { prompt, system, max_tokens = 4096, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  // 허용 모델만(오타·임의값 방지). 기본 haiku(빠르고 저렴). 캡션 등 품질 필요 시 sonnet 지정.
  const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' };
  const chosenModel = MODELS[model] || (Object.values(MODELS).includes(model) ? model : MODELS.haiku);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: chosenModel,
        max_tokens,
        system: system || '당신은 오즈키즈(영유아 제품 브랜드) 전문 마케터입니다.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

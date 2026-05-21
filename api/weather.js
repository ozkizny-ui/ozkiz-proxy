export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KMA_KEY = process.env.KMA_API_KEY || 'cEIFZw9SRtGJRWcPUsbRww';
  const STN     = '108'; // 서울

  try {
    // KST 기준 오늘 날짜
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const today  = kstNow.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD

    // 기상청 일별 자료 조회
    const url = `https://apihub.kma.go.kr/api/typ01/url/kma_sfc_aws_d.php` +
      `?tm=${today}&stn=${STN}&help=0&authKey=${KMA_KEY}`;

    const r = await fetch(url);
    const text = await r.text();

    // 응답 파싱 (공백 구분 텍스트)
    // 헤더 줄(#으로 시작) 제외하고 데이터 줄 파싱
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));

    let isRaining = false;
    let precipitation = 0;
    let minTemp = null;
    let maxTemp = null;

    if (lines.length > 0) {
      // 공백/탭 구분으로 파싱
      const parts = lines[0].trim().split(/\s+/);
      // 기상청 kma_sfc_aws_d 응답 필드 순서:
      // TM STN WS WD TA TD HM PA PS RN SD RN_DAY TA_MIN TA_MAX ...
      // 인덱스: 0=TM, 1=STN, 11=RN_DAY(일강수량), 12=TA_MIN, 13=TA_MAX
      if (parts.length >= 12) {
        precipitation = parseFloat(parts[11]) || 0;
        minTemp       = parseFloat(parts[12]) || null;
        maxTemp       = parseFloat(parts[13]) || null;
        isRaining     = precipitation > 0;
      }
    }

    // 날씨 이모지
    let emoji = '☀️';
    if (isRaining && minTemp !== null && minTemp < 0) emoji = '❄️';
    else if (isRaining) emoji = '☔';

    return res.status(200).json({
      date: today,
      isRaining,
      precipitation,
      minTemp,
      maxTemp,
      emoji,
      raw: lines[0] || '',
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

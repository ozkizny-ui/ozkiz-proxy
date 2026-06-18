// 캐러셀 그룹 검증/정렬 (작업지시서 v2 §3 carousel). 순수 함수 — I/O 없음(단위테스트 가능).
// Drive 존재여부 검사는 호출측(bulk)에서 findByName으로 수행.

const { parseMediaFilename } = require("./filename.js");

// 한 광고그룹의 행들 → 캐러셀 1개로 검증/정렬.
// rows: [{ filename, card_landing_url, campaign?, caption? }] (행 순서 뒤섞여도 됨)
// 반환 { ok:true, adName, campaign, caption, cards:[{cardNumber, filename, url}] }  (cards = 번호 오름차순)
//      | { ok:false, error }
function buildCarousel(rows) {
  if (!rows || rows.length === 0) return { ok: false, error: "빈 그룹" };

  const parsed = [];
  for (const r of rows) {
    const filename = String(r.filename || "").trim();
    if (!filename) return { ok: false, error: "카드 파일명 비어있음" };
    const url = String(r.card_landing_url || "").trim();
    if (!url) return { ok: false, error: `카드 '${filename}': 카드랜딩URL 비어있음` };
    try { new URL(url); } catch { return { ok: false, error: `카드 '${filename}': 카드랜딩URL 형식 오류` }; }
    const headline = String(r.card_headline || "").trim(); // 카드 헤드라인(소비자 노출). 비어도 됨
    const { adName, cardNumber } = parseMediaFilename(filename);
    parsed.push({ filename, url, headline, adName, cardNumber });
  }

  // 카드 2장 이상
  if (parsed.length < 2) return { ok: false, error: `카드 ${parsed.length}장 — 캐러셀은 2장 이상 필요` };

  // 그룹 내 광고세트명(adName) 전부 동일
  const names = [...new Set(parsed.map((p) => p.adName))];
  if (names.length !== 1) {
    return { ok: false, error: `그룹 내 광고세트명 불일치: ${names.map((n) => `'${n}'`).join(", ")} — 파일명(번호·확장자 제외 부분) 통일 필요` };
  }
  const adName = names[0];

  // 카드번호: 전부 존재 + 중복 없음 + 1..N 연속
  if (parsed.some((p) => p.cardNumber == null)) {
    return { ok: false, error: "카드번호 없는 파일 포함 — 파일명 끝에 (1)(2)(3) 필요" };
  }
  const sorted = parsed.map((p) => p.cardNumber).sort((a, b) => a - b);
  const dups = [...new Set(sorted.filter((n, i) => i > 0 && n === sorted[i - 1]))];
  if (dups.length) return { ok: false, error: `카드번호 중복: (${dups.join(")(")})` };
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return { ok: false, error: `카드번호 빠짐: 1~${sorted.length} 연속이어야 함, 실제 (${sorted.join(")(")})` };
  }

  // 번호 오름차순 정렬 (행 순서 무시)
  const cards = [...parsed].sort((a, b) => a.cardNumber - b.cardNumber)
    .map((p) => ({ cardNumber: p.cardNumber, filename: p.filename, url: p.url, headline: p.headline }));

  // 캠페인·캡션: 그룹 내 첫 비어있지 않은 값 (보통 그룹 첫 행에만 입력)
  const campRow = rows.find((r) => String(r.campaign || "").trim());
  const capRow  = rows.find((r) => String(r.caption || "").trim());
  return {
    ok: true,
    adName,
    campaign: campRow ? String(campRow.campaign).trim() : "",
    caption: capRow ? capRow.caption : "",
    cards,
  };
}

module.exports = { buildCarousel };

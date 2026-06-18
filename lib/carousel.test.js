const { buildCarousel } = require("./carousel.js");

let pass = 0, fail = 0;
function check(name, rows, expect) {
  const r = buildCarousel(rows);
  let ok;
  if (expect.ok) {
    ok = r.ok && r.adName === expect.adName
      && JSON.stringify(r.cards.map(c => c.cardNumber)) === JSON.stringify(expect.order)
      && JSON.stringify(r.cards.map(c => c.url)) === JSON.stringify(expect.urls)
      && r.caption === expect.caption && r.campaign === expect.campaign;
  } else {
    ok = !r.ok && r.error.includes(expect.errIncludes);
  }
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
  if (!ok) console.log("     →", JSON.stringify(r, null, 0));
}

const C = "신상카테고리(142);ai코디컷_슬라이드_260420";

// 정상: 행 뒤섞임 → 번호순 정렬, 카드별 URL 매핑, 캡션/캠페인 첫행
check("정상(행 뒤섞임 3장)", [
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1", campaign: "여름캠페인", caption: "신상 모음전" },
  { filename: `${C} (3).png`, card_landing_url: "https://ozkiz.com/p/3" },
], { ok: true, adName: C, order: [1, 2, 3], urls: ["https://ozkiz.com/p/1", "https://ozkiz.com/p/2", "https://ozkiz.com/p/3"], caption: "신상 모음전", campaign: "여름캠페인" });

// 2장(최소)
check("정상(2장)", [
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1", campaign: "c" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
], { ok: true, adName: C, order: [1, 2], urls: ["https://ozkiz.com/p/1", "https://ozkiz.com/p/2"], caption: "", campaign: "c" });

// 카드 1장 → 에러
check("1장 미만 에러", [
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1" },
], { ok: false, errIncludes: "2장 이상" });

// adName 불일치 → 에러
check("adName 불일치 에러", [
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1" },
  { filename: `다른카테고리(99);컷_260420 (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
], { ok: false, errIncludes: "광고세트명 불일치" });

// 카드번호 빠짐 (1)(3)만 → 에러
check("카드번호 빠짐 에러", [
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1" },
  { filename: `${C} (3).png`, card_landing_url: "https://ozkiz.com/p/3" },
], { ok: false, errIncludes: "빠짐" });

// 카드번호 중복 (2)(2) → 에러
check("카드번호 중복 에러", [
  { filename: `${C} (1).png`, card_landing_url: "https://ozkiz.com/p/1" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2b" },
], { ok: false, errIncludes: "중복" });

// 카드번호 없음(괄호 없는 파일) → 에러
check("카드번호 없음 에러", [
  { filename: `${C}.png`, card_landing_url: "https://ozkiz.com/p/1" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
], { ok: false, errIncludes: "카드번호 없는" });

// 카드랜딩URL 비어있음 → 에러
check("카드랜딩URL 누락 에러", [
  { filename: `${C} (1).png`, card_landing_url: "" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
], { ok: false, errIncludes: "카드랜딩URL 비어있음" });

// 카드랜딩URL 형식 오류 → 에러
check("카드랜딩URL 형식오류 에러", [
  { filename: `${C} (1).png`, card_landing_url: "ozkiz.com/p/1" },
  { filename: `${C} (2).png`, card_landing_url: "https://ozkiz.com/p/2" },
], { ok: false, errIncludes: "형식 오류" });

console.log(`\n총 ${pass + fail}건: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);

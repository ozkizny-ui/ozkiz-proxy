const { parseMediaFilename } = require("./filename.js");

// [입력, 기대 adName, 기대 cardNumber]
const cases = [
  // ── 확장자 제거 (대소문자/종류 무관) ──
  ["원피스모리본_메인컷화이트_260617.jpg",        "원피스모리본_메인컷화이트_260617", null],
  ["원피스모리본_메인컷화이트_260617.JPG",        "원피스모리본_메인컷화이트_260617", null],
  ["컷_260617.jpeg",                              "컷_260617", null],
  ["컷_260617.PNG",                               "컷_260617", null],
  ["컷_260617.gif",                               "컷_260617", null],
  ["컷_260617.webp",                              "컷_260617", null],
  ["영상_260617.mp4",                             "영상_260617", null],
  ["영상_260617.MOV",                             "영상_260617", null],

  // ── 끝 카드번호: 공백 있음/없음, 한 자리/두 자리 ──
  ["슬라이드_260618 (1).jpg",                     "슬라이드_260618", 1],
  ["슬라이드_260618(1).jpg",                      "슬라이드_260618", 1],
  ["슬라이드_260618 (10).jpg",                    "슬라이드_260618", 10],
  ["슬라이드_260618(10).png",                     "슬라이드_260618", 10],
  ["슬라이드_260618 (2)",                          "슬라이드_260618", 2],  // 확장자 없는 시트 표기

  // ── 중간 괄호(카테고리번호) 보존 — 핵심 ──
  ["크리스마스카테고리(400);컨셉영상_켄_260618.mp4", "크리스마스카테고리(400);컨셉영상_켄_260618", null],
  ["패딩카테고리(400);컨셉영상_켄_260618.mp4",       "패딩카테고리(400);컨셉영상_켄_260618", null],

  // ── 중간 괄호 + 끝 카드번호 동시 ──
  ["신상카테고리(142);ai코디컷_슬라이드_260420 (1).png", "신상카테고리(142);ai코디컷_슬라이드_260420", 1],
  ["신상카테고리(142);ai코디컷_슬라이드_260420 (2).png", "신상카테고리(142);ai코디컷_슬라이드_260420", 2],
  ["신상카테고리(142);ai코디컷_슬라이드_260420 (3).png", "신상카테고리(142);ai코디컷_슬라이드_260420", 3],
];

let pass = 0, fail = 0;
console.log("입력".padEnd(52) + " | adName".padEnd(46) + " | card | 결과");
console.log("-".repeat(120));
for (const [input, expName, expCard] of cases) {
  const r = parseMediaFilename(input);
  const ok = r.adName === expName && r.cardNumber === expCard;
  ok ? pass++ : fail++;
  console.log(
    input.padEnd(52) + " | " + r.adName.padEnd(44) + " | " +
    String(r.cardNumber).padEnd(4) + " | " + (ok ? "PASS" : `FAIL (expected adName="${expName}" card=${expCard})`)
  );
}

// ── 캐러셀 그룹 정합성: 같은 슬라이드 카드들이 동일 광고세트명으로 떨어지는가 ──
console.log("\n=== 캐러셀 묶기 정합성 ===");
const group = [
  "신상카테고리(142);ai코디컷_슬라이드_260420 (1).png",
  "신상카테고리(142);ai코디컷_슬라이드_260420 (2).png",
  "신상카테고리(142);ai코디컷_슬라이드_260420 (3).png",
];
const parsed = group.map(parseMediaFilename);
const names = new Set(parsed.map(p => p.adName));
const cardsInOrder = parsed.map(p => p.cardNumber);
const consistent = names.size === 1;
console.log("  광고세트명 집합:", [...names]);
console.log("  카드 순서:", cardsInOrder);
console.log("  → " + (consistent ? `PASS (단일 광고세트명 "${[...names][0]}")` : "FAIL (이름 불일치 — 그룹 깨짐)"));
consistent ? pass++ : fail++;

console.log(`\n총 ${pass + fail}건: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);

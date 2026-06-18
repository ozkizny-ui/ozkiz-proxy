// 광고 소재 파일명 → 광고세트명/광고명 변환 (작업지시서 v2 §2 "A 방식")
// CommonJS — Vercel(esbuild→CJS) / 로컬 node 양쪽 안전.
// 규칙:
//  1) 미디어 확장자 제거 (대소문자 무관: .JPG/.jpeg/.mov/.webp 등)
//  2) "맨 끝" 카드번호만 제거 — 선택적 공백 + (숫자). 중간 괄호( 예: 카테고리(400) )는 보존
//  3) 양끝 공백 정리
// 반환: { adName, cardNumber, ext, original }
//   adName     = 광고세트명 = 광고명 (캐러셀 묶기 키)
//   cardNumber = 끝 (n)이 있으면 정수, 없으면 null (캐러셀 카드 순서 검증용)

const MEDIA_EXT     = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|mp4|mov|m4v|webm|avi|mkv)$/i;
const TRAILING_CARD = /\s*\((\d+)\)\s*$/; // 문자열 끝 + 선택적 공백 + (숫자)

function parseMediaFilename(filename) {
  const original = String(filename == null ? "" : filename).trim();

  // 1) 확장자 제거 (있을 때만)
  const extMatch = original.match(MEDIA_EXT);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  let name = extMatch ? original.slice(0, original.length - extMatch[0].length) : original;

  // 2) 맨 끝 카드번호만 제거 (중간 괄호 보존)
  const cardMatch = name.match(TRAILING_CARD);
  const cardNumber = cardMatch ? parseInt(cardMatch[1], 10) : null;
  if (cardMatch) name = name.slice(0, name.length - cardMatch[0].length);

  // 3) 양끝 공백 정리
  name = name.trim();

  return { adName: name, cardNumber, ext, original };
}

module.exports = { parseMediaFilename };

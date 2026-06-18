// Google Drive 공개 폴더 접근 — 파일명 검색 / 다운로드(base64) / Meta file_url 생성.
// 공개 폴더("링크 있는 모든 사용자 뷰어") + Drive API 키 방식(서비스 계정 미사용).
// CommonJS — Vercel(esbuild→CJS) / 로컬 node 양쪽 안전.

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const AD_MEDIA_FOLDER = "1Owv3k2aYgeatjnke-pS-PVKvN2AIggP5"; // 광고 소재 전용 폴더(고정)

function driveKey() { return process.env.GOOGLE_DRIVE_API_KEY; }

// Meta advideos file_url용 — API 미디어 URL(대용량도 완전바이트, 바이러스검사 HTML 없음).
function mediaUrl(fileId, key) {
  return `${DRIVE_API}/files/${fileId}?alt=media&key=${key}`;
}

// 폴더 전체 리스트 (페이징 — 1000개 초과 폴더 대비)
async function listFolder(folderId, key) {
  const q = `'${folderId}' in parents and trashed=false`;
  const files = [];
  let pageToken = "", guard = 0;
  do {
    const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
      `&fields=${encodeURIComponent("nextPageToken,files(id,name,mimeType,size)")}` +
      `&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}&key=${key}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) return { ok: false, error: d.error.message };
    if (Array.isArray(d.files)) files.push(...d.files);
    pageToken = d.nextPageToken || "";
    guard++;
  } while (pageToken && guard < 20);
  return { ok: true, files };
}

// ── 관용 파일명 매칭 (시트 입력 ↔ Drive 실제 파일명) ──
// 차이 흡수: ① 유니코드 정규화(NFC) ② 확장자 유무(시트엔 없고 파일엔 .jpg 등) ③ 대소문자.
// 세미콜론/괄호/공백은 JS 비교라 escaping 무관.
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|mp4|mov|m4v|webm|avi|mkv)$/i;
const baseKey = (s) => String(s == null ? "" : s).normalize("NFC").trim().replace(MEDIA_EXT_RE, "").toLowerCase();

// 사전 조회한 파일 목록(listFolder)에서 시트 파일명 매칭. 반환 { hits, file, files }
function matchByName(files, sheetName) {
  const key = baseKey(sheetName);
  const hits = (files || []).filter((f) => baseKey(f.name) === key);
  return { hits: hits.length, file: hits[0] || null, files: hits };
}

// 파일명 정확검색 (대량 업로드 핵심 경로) → 0건/중복 탐지
// 반환 { ok, hits, file, files } | { ok:false, error }
async function findByName(folderId, filename, key) {
  const safe = String(filename).replace(/'/g, "\\'");
  const q = `'${folderId}' in parents and name='${safe}' and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,size)")}&key=${key}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) return { ok: false, error: d.error.message };
  const files = d.files || [];
  return { ok: true, hits: files.length, file: files[0] || null, files };
}

// 파일 다운로드 → base64 (이미지용: adimages는 bytes=base64로 업로드. 영상은 file_url 사용하므로 불필요)
async function downloadBase64(fileId, key) {
  const r = await fetch(mediaUrl(fileId, key));
  if (!r.ok) return { ok: false, error: `Drive 다운로드 HTTP ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: true, base64: buf.toString("base64"), bytes: buf.length };
}

module.exports = { DRIVE_API, AD_MEDIA_FOLDER, driveKey, mediaUrl, listFolder, findByName, matchByName, baseKey, downloadBase64 };

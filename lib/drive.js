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

// 폴더 전체 리스트
async function listFolder(folderId, key) {
  const q = `'${folderId}' in parents and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,size)")}&pageSize=1000&key=${key}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) return { ok: false, error: d.error.message };
  return { ok: true, files: d.files || [] };
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

module.exports = { DRIVE_API, AD_MEDIA_FOLDER, driveKey, mediaUrl, listFolder, findByName, downloadBase64 };

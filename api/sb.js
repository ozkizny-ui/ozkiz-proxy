// ── /api/sb — Supabase 데이터 게이트웨이 (service_role) ─────────────────────
// ad-studio / dashboard 프론트의 anon 직접 호출을 대체하는 단일 창구.
// 허용목록(ALLOW) 밖의 (table, op)는 전부 403. delete 단독 노출 없음(replace 내부에서만).
//
// ⚠️ auto-adjust.js 와 완전 분리 — 이 파일은 가산적으로 추가됨. 기존 엔드포인트 무변경.
// ⚠️ 인증: 4단계에서 requireWriteAuth()에 구현. 지금은 통과(무인증) — 그래서 이 단계에서는
//    RLS를 잠그면 안 됨(무인증 창구가 곧 구멍). RLS 잠금은 4단계 인증 이후 5단계에서만.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyBearer } from '../lib/auth.js';

const SB_URL = process.env.SUPABASE_URL || 'https://baucagnqmtmaqlybjyzc.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // auto-adjust.js와 동일 env 재사용

// ── 쓰기 인증 env (4단계) ─────────────────────────────────────────────────────
const APP_PASSWORD = process.env.SB_APP_PASSWORD;            // 팀 공용 쓰기 비밀번호 (Vercel env, 미설정 시 op:'auth' 503)
const JWT_SECRET   = process.env.SB_JWT_SECRET;              // HS256 서명 시크릿 (Vercel env)
const WRITE_AUTH_ENABLED = process.env.WRITE_AUTH_ENABLED === 'true'; // 미설정/기타 → false (검증 OFF, 안전 기본)
const TOKEN_TTL = 12 * 60 * 60;                             // 12시간(초)

// inventory replace(34k: 백업읽기 + delete + ~35 insert ≈ 15~20s)가 기본 10초를 넘으므로 60초로.
// 타임아웃 시 backup-restore가 안 돌아 데이터 손실 위험 → 충분한 여유 확보.
// (bulk-create-ads.js가 같은 Hobby 플랜에서 maxDuration:60 사용 — 지원 입증됨)
export const config = { maxDuration: 60 };

// 허용목록: (table, op) 강제 + read 고정 select + upsert 충돌키.
// 계획의 6개 테이블 중 app_settings 는 호출 0곳 → 미등록(자동 403).
const ALLOW = {
  inventory:       { read: 'name,option,avail,store,cost,rep_code,updated_at', replace: true },
  strategy:        { read: 'name,season,category',                             replace: true },
  sera:            { read: 'code,name,views,orders,opv,click_value',           replace: true },
  product_url:     { read: 'ez_name,url,product_no',          upsert: 'ez_name' }, // PK=ez_name
  creative_status: { read: 'key,status',                      upsert: 'key'     }, // 충돌키=key
  budget_rules:    { upsert: 'id' },                                               // 규칙편집(5-bis 통합). read 불필요(프론트는 localStorage). auto-adjust는 service_role 직접이라 무관
  budget_rule_edits: { read: 'created_at,editor,rule_id,field,before_val,after_val,memo', upsert: 'id' }, // 규칙편집 감사로그(append). id auto-gen이라 upsert=insert
};

const PAGE = 1000;

function sbHeaders(extra) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ── 쓰기 인증 (앱 비밀번호 → HS256 JWT, 의존성 없음 — node:crypto) ─────────────
const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// JWT_SECRET 존재 전제(op:'auth'에서 확인 후 호출).
function signToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { role: 'w', iat: now, exp: now + TOKEN_TTL };
  const data = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(payload)}`;
  const sig = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return { token: `${data}.${sig}`, exp: payload.exp };
}

// 쓰기 인증 훅: WRITE_AUTH_ENABLED=false면 통과(검증 OFF, 안전 기본).
// 검증 로직은 lib/auth.js의 verifyBearer로 분리(meta·bulk 공유) — JWT_SECRET 없으면 false(fail-closed).
// signToken(발급)은 op:'auth' 전용이라 sb.js에 유지.
async function requireWriteAuth(req) {
  if (!WRITE_AUTH_ENABLED) return true;
  return verifyBearer(req);
}

// read: 1000행씩 페이지네이션해서 전량 반환 (inventory ~34k행 대응).
async function readAll(table, select) {
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const r = await fetch(`${SB_URL}/rest/v1/${table}?select=${select}`, {
      headers: sbHeaders({ 'Range-Unit': 'items', Range: `${from}-${to}` }),
    });
    if (!r.ok) throw new Error(`read ${table} ${r.status}: ${await r.text()}`);
    const chunk = await r.json();
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all = all.concat(chunk);
    if (chunk.length < PAGE) break;
  }
  return all;
}

async function insertChunks(table, rows) {
  for (let i = 0; i < rows.length; i += PAGE) {
    const slice = rows.slice(i, i + PAGE);
    const ins = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(slice),
    });
    if (!ins.ok) throw new Error(`insert @${i} ${ins.status}: ${await ins.text()}`);
  }
}
async function deleteAll(table) {
  const del = await fetch(`${SB_URL}/rest/v1/${table}?id=gte.0`, {
    method: 'DELETE',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
  });
  if (!del.ok) throw new Error(`delete ${table} ${del.status}: ${await del.text()}`);
}

// replace: 전체 교체 + backup-restore (증발 방지).
// 1) DELETE 전 현재 전체 행을 메모리 백업
// 2) 삭제 → 새 데이터 삽입
// 3) 삽입 실패 시: 부분삽입분 제거 후 백업 재삽입(원상복구). 복구도 실패하면 조용히 두지 말고
//    "수동복구 필요" 명확한 에러로 throw.
// 빈 배열은 핸들러에서 이미 거부(통째 비우기 방지).
async function replaceAll(table, rows) {
  // 1) 백업 (실패 시 삭제 전이라 데이터 보존된 채 중단)
  let backup;
  try {
    backup = await readAll(table, '*');
  } catch (e) {
    throw new Error(`replace ${table}: 백업 읽기 실패 → 중단(데이터 보존). ${e.message}`);
  }

  // 2) 삭제 (삭제 자체 실패 시 테이블 보존된 채 throw)
  await deleteAll(table);

  // 3) 새 데이터 삽입; 실패 시 백업으로 원상복구
  try {
    await insertChunks(table, rows);
    return { inserted: rows.length, restored: false, backupCount: backup.length };
  } catch (insErr) {
    // 복구 시도 (이 try는 복구 작업만 감쌈)
    try {
      await deleteAll(table);            // 부분삽입분 제거
      // 복구 재삽입은 id를 빼서(정상 insert와 동일) — id가 generated always여도 안전. id는 앱이 안 씀, updated_at은 보존.
      const restoreRows = backup.map(({ id, ...rest }) => rest);
      await insertChunks(table, restoreRows); // 원본 복구(id 재생성)
    } catch (restoreErr) {
      throw new Error(`⚠️ 수동복구 필요: replace ${table} 삽입 실패 후 복구도 실패 — 테이블이 부분/빈 상태일 수 있음(원본 ${backup.length}행). insert오류=${insErr.message} / 복구오류=${restoreErr.message}`);
    }
    // 복구 성공 → 저장은 실패했지만 원본 보존됨 (수동복구 불필요)
    const err = new Error(`replace ${table}: 삽입 실패 → 원본 ${backup.length}행 복구 완료. 저장 실패(데이터 보존). 원인=${insErr.message}`);
    err.restored = true;
    throw err;
  }
}

// upsert: 단건/소량 merge-duplicates (PK/충돌키 기준). 현 프론트 동작과 동일.
async function upsertRows(table, rows, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`upsert ${table} ${r.status}: ${await r.text()}`);
  return { upserted: rows.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // TODO(step4): ad-studio/dashboard origin으로 제한
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  const { op, table, rows, password } = req.body || {};
  if (!op) return res.status(400).json({ error: 'op is required' });

  try {
    // 토큰 발급 (table 불필요): 비번 일치 → 12h HS256 JWT. env 미설정 시 503(크래시 X).
    if (op === 'auth') {
      if (!APP_PASSWORD || !JWT_SECRET) return res.status(503).json({ error: 'auth not configured (SB_APP_PASSWORD/SB_JWT_SECRET 미설정)' });
      const a = Buffer.from(String(password || '')), b = Buffer.from(APP_PASSWORD);
      if (!(a.length === b.length && timingSafeEqual(a, b))) return res.status(401).json({ error: 'invalid password' });
      return res.status(200).json(signToken());
    }

    if (!table) return res.status(400).json({ error: 'table is required' });
    const conf = ALLOW[table];
    if (!conf) return res.status(403).json({ error: `table not allowed: ${table}` });

    if (op === 'read') {
      if (!conf.read) return res.status(403).json({ error: `read not allowed: ${table}` });
      const data = await readAll(table, conf.read);
      return res.status(200).json({ data });
    }

    if (op === 'replace') {
      if (!conf.replace) return res.status(403).json({ error: `replace not allowed: ${table}` });
      if (!(await requireWriteAuth(req))) return res.status(401).json({ error: 'unauthorized' });
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
      if (rows.length === 0) return res.status(400).json({ error: 'replace requires non-empty rows' });
      const out = await replaceAll(table, rows);
      return res.status(200).json(out);
    }

    if (op === 'upsert') {
      if (!conf.upsert) return res.status(403).json({ error: `upsert not allowed: ${table}` });
      if (!(await requireWriteAuth(req))) return res.status(401).json({ error: 'unauthorized' });
      const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      if (arr.length === 0) return res.status(400).json({ error: 'rows required' });
      const out = await upsertRows(table, arr, conf.upsert);
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: `unknown op: ${op}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

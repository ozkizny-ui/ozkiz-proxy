// lib/auth.js — 공유 쓰기 인증 (HS256 JWT 검증). sb.js·meta.js·bulk-create-ads.js 공용.
// 발급(signToken)은 sb.js의 op:'auth'에만. 여기는 검증만.
// JWT_SECRET(env) 없으면 verify는 항상 false(fail-closed).
import { createHmac, timingSafeEqual } from 'node:crypto';

const JWT_SECRET = process.env.SB_JWT_SECRET;

export function verifyToken(token) {
  if (!token || !JWT_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const expected = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false; // 서명 불일치
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !!payload.exp && payload.exp >= Math.floor(Date.now() / 1000); // 만료 확인
  } catch { return false; }
}

// Authorization: Bearer <token> 검증. 헤더 없거나 서명/만료 불일치/시크릿 미설정 → false.
export function verifyBearer(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? verifyToken(m[1]) : false;
}

import jwt from 'jsonwebtoken'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set')
}

export const ACCESS_TOKEN_TTL = '15m'
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export type AccessTokenPayload = {
  sub: string // user id
  role: string
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET!, { expiresIn: ACCESS_TOKEN_TTL })
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET!) as AccessTokenPayload
}

// The refresh token itself is a signed JWT (carries the user id + a random
// jti so each one is unique), but its hash is also stored server-side in
// RefreshToken — possession of a valid-looking JWT isn't enough on its own,
// it must also match a non-revoked, non-expired row. That's what makes
// rotation/revocation (logout, compromise) actually work.
export type RefreshTokenPayload = {
  sub: string
  jti: string
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, REFRESH_SECRET!, {
    expiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  })
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, REFRESH_SECRET!) as RefreshTokenPayload
}

import crypto from 'node:crypto'
import { prisma } from '../lib/prisma'
import {
  REFRESH_TOKEN_TTL_MS,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt'
import type { User } from '../generated/prisma/client'

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function findOrCreateUserByPhone(phoneNumber: string): Promise<User> {
  return prisma.user.upsert({
    where: { phoneNumber },
    update: {},
    create: { phoneNumber },
  })
}

export async function issueSession(user: User) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role })

  const jti = crypto.randomUUID()
  const refreshToken = signRefreshToken({ sub: user.id, jti })

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  })

  return { accessToken, refreshToken }
}

export class InvalidRefreshTokenError extends Error {}

/** Verifies + rotates a refresh token: revokes the old one, issues a new pair. */
export async function rotateSession(refreshToken: string) {
  let payload
  try {
    payload = verifyRefreshToken(refreshToken)
  } catch {
    throw new InvalidRefreshTokenError('Invalid refresh token')
  }

  const tokenHash = hashToken(refreshToken)
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } })

  if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
    throw new InvalidRefreshTokenError('Refresh token is invalid or expired')
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } })
  if (!user) throw new InvalidRefreshTokenError('User no longer exists')

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  })

  return issueSession(user)
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken)
  await prisma.refreshToken
    .updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {})
}

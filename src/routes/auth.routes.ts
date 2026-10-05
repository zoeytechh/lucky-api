import { Router } from 'express'
import { z } from 'zod'
import { normalizeNigerianPhone } from '../lib/phone'
import { REFRESH_TOKEN_TTL_MS } from '../lib/jwt'
import { requireAuth } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import {
  OtpExpiredError,
  OtpInvalidError,
  OtpRateLimitError,
  OtpTooManyAttemptsError,
  requestOtp,
  verifyOtp,
} from '../services/otp.service'
import {
  InvalidRefreshTokenError,
  findOrCreateUserByPhone,
  issueSession,
  revokeRefreshToken,
  rotateSession,
} from '../services/auth.service'

const router = Router()

const REFRESH_COOKIE = 'refresh_token'
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_TTL_MS,
}

const phoneSchema = z.object({ phoneNumber: z.string().min(7) })
const verifySchema = z.object({
  phoneNumber: z.string().min(7),
  code: z.string().length(6),
})

router.post('/otp/request', async (req, res) => {
  const parsed = phoneSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Invalid phone number' })

  const phone = normalizeNigerianPhone(parsed.data.phoneNumber)
  if (!phone) return res.status(400).json({ message: 'Invalid phone number' })

  try {
    await requestOtp(phone)
    res.json({ sent: true })
  } catch (err) {
    if (err instanceof OtpRateLimitError) {
      return res.status(429).json({ message: err.message })
    }
    throw err
  }
})

router.post('/otp/verify', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Invalid request' })

  const phone = normalizeNigerianPhone(parsed.data.phoneNumber)
  if (!phone) return res.status(400).json({ message: 'Invalid phone number' })

  try {
    await verifyOtp(phone, parsed.data.code)
  } catch (err) {
    if (
      err instanceof OtpInvalidError ||
      err instanceof OtpExpiredError ||
      err instanceof OtpTooManyAttemptsError
    ) {
      return res.status(400).json({ message: err.message })
    }
    throw err
  }

  const user = await findOrCreateUserByPhone(phone)
  const { accessToken, refreshToken } = await issueSession(user)

  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions)
  res.json({
    accessToken,
    user: {
      id: user.id,
      phoneNumber: user.phoneNumber,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    },
  })
})

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE]
  if (!token) return res.status(401).json({ message: 'Not authenticated' })

  try {
    const { accessToken, refreshToken } = await rotateSession(token)
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions)
    res.json({ accessToken })
  } catch (err) {
    if (err instanceof InvalidRefreshTokenError) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      return res.status(401).json({ message: err.message })
    }
    throw err
  }
})

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, phoneNumber: true, fullName: true, avatarUrl: true, role: true },
  })
  res.json({ user })
})

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE]
  if (token) await revokeRefreshToken(token)
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
  res.json({ loggedOut: true })
})

export default router

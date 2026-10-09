import crypto from 'node:crypto'
import { prisma } from '../lib/prisma'
import { sendSms } from '../lib/sms'

const OTP_TTL_MS = 5 * 60 * 1000
const REQUEST_COOLDOWN_MS = 60 * 1000
const MAX_VERIFY_ATTEMPTS = 5

const PEPPER = process.env.OTP_PEPPER
if (!PEPPER) throw new Error('OTP_PEPPER must be set')

function hashCode(code: string): string {
  return crypto.createHmac('sha256', PEPPER!).update(code).digest('hex')
}

export class OtpRateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}
export class OtpInvalidError extends Error {}
export class OtpExpiredError extends Error {}
export class OtpTooManyAttemptsError extends Error {}

export async function requestOtp(phoneNumber: string): Promise<void> {
  const recent = await prisma.otpCode.findFirst({
    where: { phoneNumber },
    orderBy: { createdAt: 'desc' },
  })

  if (recent) {
    const elapsedMs = Date.now() - recent.createdAt.getTime()
    if (elapsedMs < REQUEST_COOLDOWN_MS) {
      // The actual remaining wait, not just a client-guessed 60s — the
      // frontend countdown needs this to stay accurate however the
      // client got here (a fresh "Send code" after going back and
      // resubmitting the same number has no prior countdown running at
      // all, so without this it had nothing to show).
      const retryAfterSeconds = Math.ceil((REQUEST_COOLDOWN_MS - elapsedMs) / 1000)
      throw new OtpRateLimitError('Please wait before requesting another code', retryAfterSeconds)
    }
  }

  // Dev mode (no Termii key configured yet): fixed code, no SMS cost,
  // easy to test with. Remove this branch once TERMII_API_KEY is set for
  // real — a predictable code must never ship to production.
  const code = process.env.TERMII_API_KEY
    ? crypto.randomInt(100000, 1000000).toString()
    : '123456'

  await prisma.otpCode.create({
    data: {
      phoneNumber,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  })

  await sendSms(phoneNumber, `Your Lucky You verification code is ${code}. It expires in 5 minutes.`)
}

export async function verifyOtp(phoneNumber: string, code: string): Promise<void> {
  const otp = await prisma.otpCode.findFirst({
    where: { phoneNumber, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })

  if (!otp) throw new OtpInvalidError('No code requested for this number')
  if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new OtpTooManyAttemptsError('Too many attempts — request a new code')
  }
  if (otp.expiresAt.getTime() < Date.now()) {
    throw new OtpExpiredError('Code has expired — request a new one')
  }

  if (otp.codeHash !== hashCode(code)) {
    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    })
    throw new OtpInvalidError('Incorrect code')
  }

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() },
  })
}

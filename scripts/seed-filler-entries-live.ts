/**
 * Same purpose as seed-filler-entries.ts (pad the open round with
 * throwaway entries for manual testing), but places each entry through
 * the real deployed HTTP API instead of writing to the database
 * directly — so it goes through the live server's own initSocket()
 * instance and actually broadcasts 'round:progress' to anyone watching
 * the real app, the same as a genuine entry would. The DB-direct version
 * can never do this: it runs as its own disconnected process with no
 * HTTP server, so there's nothing for it to broadcast on (see its own
 * comment) — fine for local-only testing, not for watching the live app.
 *
 * Usage: npx tsx scripts/seed-filler-entries-live.ts <count>
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { ENTRY_COST_MINOR } from '../src/config/constants'
import { prisma, runInTransaction } from '../src/lib/prisma'
import { credit } from '../src/services/wallet.service'

const PROD_API_URL = 'https://lucky-api-0hbe.onrender.com'
const DEV_OTP_CODE = '123456' // only works while TERMII_API_KEY is unset — see otp.service.ts

// This sandbox's first Neon/Prisma connection in a process occasionally
// hits a transient local DNS blip (EAI_AGAIN) — seen repeatedly
// elsewhere this session too, always gone on retry. Not a real outage
// (the already-running server's own /api/health stays green throughout);
// just worth not letting it kill an otherwise-working run.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr
}

function randomNigerianPhone(): string {
  // 11-digit local format (0 + 10 digits) — normalizeNigerianPhone just
  // checks shape, not a real carrier range, so any 10-digit tail works.
  const tail = Math.floor(1_000_000_000 + Math.random() * 8_999_999_999).toString()
  return `0${tail}`
}

async function main() {
  const count = Number(process.argv[2]) || 2

  for (let i = 0; i < count; i++) {
    const phone = randomNigerianPhone()

    const otpRes = await fetch(`${PROD_API_URL}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone }),
    })
    if (!otpRes.ok) throw new Error(`otp/request failed: ${otpRes.status} ${await otpRes.text()}`)

    const verifyRes = await fetch(`${PROD_API_URL}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, code: DEV_OTP_CODE }),
    })
    if (!verifyRes.ok) throw new Error(`otp/verify failed: ${verifyRes.status} ${await verifyRes.text()}`)
    const { accessToken, user } = await verifyRes.json()

    // requireCompleteProfile needs both set — done directly against the
    // (shared) database rather than the multipart avatar-upload route,
    // since the content of the photo doesn't matter here.
    await withRetry(() =>
      prisma.user.update({
        where: { id: user.id },
        data: { fullName: `Filler ${i + 1}`, avatarUrl: 'https://api.dicebear.com/9.x/identicon/svg?seed=filler' },
      }),
    )

    await withRetry(() =>
      runInTransaction((tx) =>
        credit(tx, {
          userId: user.id,
          amountMinor: ENTRY_COST_MINOR * 2n,
          entryType: 'DEPOSIT',
          idempotencyKey: `filler-fund-live:${randomUUID()}`,
        }),
      ),
    )

    const entryRes = await fetch(`${PROD_API_URL}/api/draw/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ idempotencyKey: `filler-entry-live:${randomUUID()}` }),
    })
    if (!entryRes.ok) throw new Error(`entries failed: ${entryRes.status} ${await entryRes.text()}`)
    const result = await entryRes.json()
    console.log(`Filler ${i + 1}: entered as slot ${result.slotNumber} (round ${result.roundNumber})`)
  }

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})

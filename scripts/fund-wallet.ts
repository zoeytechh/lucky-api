/**
 * Dev-only utility: credits a user's wallet directly, bypassing the
 * (not-yet-built) Paystack deposit flow — M7. Useful for manually testing
 * anything that needs a funded wallet until then.
 *
 * Usage: npm run fund -- 08031234567 [amountInNaira]
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { normalizeNigerianPhone } from '../src/lib/phone'
import { prisma, runInTransaction } from '../src/lib/prisma'
import { credit } from '../src/services/wallet.service'

async function main() {
  const [phoneArg, amountArg] = process.argv.slice(2)
  if (!phoneArg) {
    console.error('usage: npm run fund -- <phone e.g. 08031234567> [amountInNaira, default 5000]')
    process.exit(1)
  }

  const phone = normalizeNigerianPhone(phoneArg)
  if (!phone) {
    console.error(`"${phoneArg}" doesn't look like a valid Nigerian phone number`)
    process.exit(1)
  }

  const amountNaira = amountArg ? Number(amountArg) : 5000
  const amountMinor = BigInt(Math.round(amountNaira * 100))

  const user = await prisma.user.findUnique({ where: { phoneNumber: phone } })
  if (!user) {
    console.error(`No user found for ${phone} — they need to sign up first.`)
    process.exit(1)
  }

  const { balanceMinor } = await runInTransaction((tx) =>
    credit(tx, {
      userId: user.id,
      amountMinor,
      entryType: 'DEPOSIT',
      idempotencyKey: `dev-fund:${randomUUID()}`,
    }),
  )

  console.log(`Credited ${phone} ₦${amountNaira.toLocaleString()} — new balance: ₦${(Number(balanceMinor) / 100).toLocaleString()}`)
  await prisma.$disconnect()
}

main()

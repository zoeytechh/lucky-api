/**
 * Dev-only: places N filler entries from throwaway funded accounts, so a
 * human tester can be the entry that completes the round themselves.
 * Usage: npx tsx scripts/seed-filler-entries.ts <count>
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { ENTRY_COST_MINOR } from '../src/config/constants'
import { prisma, runInTransaction } from '../src/lib/prisma'
import { placeEntry } from '../src/services/draw.service'
import { credit } from '../src/services/wallet.service'

async function main() {
  const count = Number(process.argv[2]) || 2

  for (let i = 0; i < count; i++) {
    const phone = `+1FILLER${randomUUID()}`
    // A real fullName (not left null) so this filler shows up in the
    // recent-entries feed with a readable name instead of falling back
    // to a masked phone number — purely cosmetic for manual testing.
    const user = await prisma.user.create({
      data: { phoneNumber: phone, fullName: `Filler ${i + 1}` },
    })
    await runInTransaction((tx) =>
      credit(tx, {
        userId: user.id,
        amountMinor: ENTRY_COST_MINOR * 2n,
        entryType: 'DEPOSIT',
        idempotencyKey: `filler-fund:${randomUUID()}`,
      }),
    )
    const result = await placeEntry(user.id, `filler-entry:${randomUUID()}`)
    console.log(`Filler ${i + 1}: entered as slot ${result.slotNumber} (round ${result.roundNumber})`)
  }

  const round = await prisma.drawRound.findFirst({ where: { status: 'OPEN' } })
  console.log(`Open round now at ${round?.entryCount}/${round ? 'capacity' : '?'}`)
  await prisma.$disconnect()
}

main()

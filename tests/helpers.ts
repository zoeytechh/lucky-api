import { randomUUID } from 'node:crypto'
import { prisma, runInTransaction } from '../src/lib/prisma'
import { credit } from '../src/services/wallet.service'

// Clearly-fake phone numbers, distinct from any real Nigerian (+234) number
// a developer might create while manually testing against this same dev
// database — makes test data easy to spot and clean up.
export async function createTestUser() {
  return prisma.user.create({
    data: { phoneNumber: `+1TEST${randomUUID()}` },
  })
}

/** A test user with a wallet pre-funded via a real ledger-posted credit (not a shortcut balance write). */
export async function createFundedTestUser(balanceMinor: bigint) {
  const user = await createTestUser()
  await runInTransaction((tx) =>
    credit(tx, {
      userId: user.id,
      amountMinor: balanceMinor,
      entryType: 'DEPOSIT',
      idempotencyKey: `test-fund:${randomUUID()}`,
    }),
  )
  return user
}

export async function createFundedTestUsers(count: number, balanceMinor: bigint) {
  const users = []
  for (let i = 0; i < count; i++) {
    users.push(await createFundedTestUser(balanceMinor))
  }
  return users
}

export async function cleanupTestUser(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (wallet) {
    await prisma.ledgerEntry.deleteMany({ where: { walletId: wallet.id } })
    await prisma.wallet.delete({ where: { id: wallet.id } })
  }
  await prisma.drawEntry.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}

export async function cleanupTestUsers(userIds: string[]) {
  for (const id of userIds) {
    await cleanupTestUser(id)
  }
}

/**
 * Deletes any DrawRound with zero remaining DrawEntry rows — safe general
 * test cleanup covering both rounds a test used directly (once its own
 * entries are gone, via cleanupTestUser above) and the empty round a
 * settlement always opens as a side effect, which no test explicitly
 * "owns". An empty round carries no information worth preserving between
 * test runs; the next lockOpenRound call creates one on demand regardless.
 */
export async function cleanupEmptyRounds() {
  const empty = await prisma.drawRound.findMany({
    where: { entries: { none: {} } },
    select: { id: true },
  })
  if (empty.length > 0) {
    await prisma.drawRound.deleteMany({ where: { id: { in: empty.map((r) => r.id) } } })
  }
}

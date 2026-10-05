import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/prisma'

// Clearly-fake phone numbers, distinct from any real Nigerian (+234) number
// a developer might create while manually testing against this same dev
// database — makes test data easy to spot and clean up.
export async function createTestUser() {
  return prisma.user.create({
    data: { phoneNumber: `+1TEST${randomUUID()}` },
  })
}

export async function cleanupTestUser(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (wallet) {
    await prisma.ledgerEntry.deleteMany({ where: { walletId: wallet.id } })
    await prisma.wallet.delete({ where: { id: wallet.id } })
  }
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}

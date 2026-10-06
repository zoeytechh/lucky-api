import { afterEach, describe, expect, it } from 'vitest'
import { ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../../src/config/constants'
import { prisma, runInTransaction } from '../../src/lib/prisma'
import { decideSettlement } from '../../src/services/settlement.service'
import { cleanupEmptyRounds, cleanupTestUsers, createTestUser } from '../helpers'

/**
 * Tests decideSettlement in isolation: a round + exactly ROUND_SIZE
 * entries created directly (not via placeEntry), so this exercises the
 * shuffle/partition/bookkeeping logic on its own, at the small test
 * ROUND_SIZE set in tests/setup.ts — same code and formula as production,
 * just fast. The full entry-flow test (draw-entry.test.ts) covers
 * decideSettlement as triggered by real concurrent entries.
 */
describe('settlement: decide step', () => {
  let userIds: string[] = []
  let roundId: string | null = null

  afterEach(async () => {
    if (roundId) {
      await prisma.drawEntry.deleteMany({ where: { roundId } })
      await prisma.drawRound.delete({ where: { id: roundId } }).catch(() => {})
    }
    await cleanupTestUsers(userIds)
    await cleanupEmptyRounds()
    userIds = []
    roundId = null
  })

  async function createFullRound() {
    // At most one OPEN round can ever exist (partial unique index) — once
    // any round has ever been created anywhere in this shared dev
    // database (by another test file, or manual testing), there's always
    // one left open. Force-close it before creating this test's own —
    // its contents don't matter here, this suite only cares about
    // decideSettlement's behavior on the round it builds itself.
    await prisma.drawRound.updateMany({
      where: { status: 'OPEN' },
      data: { status: 'SETTLED', settledAt: new Date() },
    })

    const round = await prisma.drawRound.create({ data: { status: 'OPEN' } })
    roundId = round.id

    for (let slot = 1; slot <= ROUND_SIZE; slot++) {
      const user = await createTestUser()
      userIds.push(user.id)
      await prisma.drawEntry.create({
        data: {
          roundId: round.id,
          userId: user.id,
          slotNumber: slot,
          stakeMinor: STAKE_MINOR,
          feeMinor: 20_000n,
          idempotencyKey: `settlement-test:${user.id}`,
        },
      })
    }
    return round.id
  }

  it('partitions exactly 1 winner, and splits the rest with the extra rounding into refunded', async () => {
    const id = await createFullRound()
    await runInTransaction((tx) => decideSettlement(tx, id))

    const entries = await prisma.drawEntry.findMany({ where: { roundId: id } })
    const won = entries.filter((e) => e.outcome === 'WON')
    const refunded = entries.filter((e) => e.outcome === 'REFUNDED')
    const lost = entries.filter((e) => e.outcome === 'LOST')

    const expectedRefund = Math.ceil((ROUND_SIZE - 1) / 2)
    const expectedLoss = Math.floor((ROUND_SIZE - 1) / 2)

    expect(won).toHaveLength(1)
    expect(refunded).toHaveLength(expectedRefund)
    expect(lost).toHaveLength(expectedLoss)
    expect(won.length + refunded.length + lost.length).toBe(ROUND_SIZE)

    // No entry left PENDING, no entry counted twice.
    expect(entries.every((e) => e.outcome !== 'PENDING')).toBe(true)
    const uniqueIds = new Set(entries.map((e) => e.id))
    expect(uniqueIds.size).toBe(ROUND_SIZE)
  })

  it('the planned payout math balances: winner + refunds == total stake collected', async () => {
    const id = await createFullRound()
    await runInTransaction((tx) => decideSettlement(tx, id))

    const entries = await prisma.drawEntry.findMany({ where: { roundId: id } })
    const totalStake = BigInt(ROUND_SIZE) * STAKE_MINOR
    const plannedPayout = entries.reduce((acc, e) => acc + (e.payoutMinor ?? 0n), 0n)

    expect(plannedPayout).toBe(totalStake)

    const won = entries.find((e) => e.outcome === 'WON')!
    expect(won.payoutMinor).toBe(WINNER_PAYOUT_MINOR)
    const lost = entries.filter((e) => e.outcome === 'LOST')
    expect(lost.every((e) => e.payoutMinor === 0n)).toBe(true)
  })

  it('marks the round SETTLED, records the winner and audit trail, and opens exactly one new round', async () => {
    const id = await createFullRound()
    const openBefore = await prisma.drawRound.count({ where: { status: 'OPEN' } })

    await runInTransaction((tx) => decideSettlement(tx, id))

    const round = await prisma.drawRound.findUniqueOrThrow({ where: { id } })
    expect(round.status).toBe('SETTLED')
    expect(round.winnerEntryId).toBeTruthy()
    expect(round.settledAt).toBeTruthy()
    expect(round.shuffleAudit).toBeTruthy()

    const winnerEntry = await prisma.drawEntry.findUniqueOrThrow({
      where: { id: round.winnerEntryId! },
    })
    expect(winnerEntry.outcome).toBe('WON')

    const openAfter = await prisma.drawRound.count({ where: { status: 'OPEN' } })
    expect(openAfter).toBe(openBefore) // one closed, one opened — net unchanged
  })

  it('lost entries are marked settled immediately (no payout ever owed); won/refunded are not yet (payout still outstanding)', async () => {
    const id = await createFullRound()
    await runInTransaction((tx) => decideSettlement(tx, id))

    const entries = await prisma.drawEntry.findMany({ where: { roundId: id } })
    const lost = entries.filter((e) => e.outcome === 'LOST')
    const needsPayout = entries.filter((e) => e.outcome === 'WON' || e.outcome === 'REFUNDED')

    expect(lost.every((e) => e.settledAt !== null)).toBe(true)
    expect(needsPayout.every((e) => e.settledAt === null)).toBe(true)
  })
})

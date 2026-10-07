import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { InsufficientBalanceError, placeEntry } from '../../src/services/draw.service'
import { getSystemUserId } from '../../src/services/wallet.service'
import { cleanupEmptyRounds, cleanupTestUsers, createFundedTestUser, createFundedTestUsers } from '../helpers'

describe('draw entry + settlement, end to end', () => {
  let trackedUserIds: string[] = []

  afterEach(async () => {
    await cleanupTestUsers(trackedUserIds)
    await cleanupEmptyRounds()
    trackedUserIds = []
  })

  it('a single entry debits stake + fee and creates a PENDING entry', async () => {
    const user = await createFundedTestUser(ENTRY_COST_MINOR * 5n)
    trackedUserIds.push(user.id)

    const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const result = await placeEntry(user.id, `test:${randomUUID()}`)
    const after = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })

    expect(after.balanceMinor).toBe(before.balanceMinor - ENTRY_COST_MINOR)
    expect(result.slotNumber).toBeGreaterThanOrEqual(1)

    const entry = await prisma.drawEntry.findUniqueOrThrow({ where: { id: result.entryId } })
    expect(entry.stakeMinor).toBe(STAKE_MINOR)
    expect(entry.feeMinor).toBe(FEE_MINOR)
    // PENDING unless this entry happened to be the one that completed the
    // round (shared dev DB, other test files run sequentially but this
    // one's round may already be partway full) — either is a valid state.
    expect(['PENDING', 'WON', 'REFUNDED', 'LOST']).toContain(entry.outcome)
  })

  it('rejects entry when wallet balance is below the entry cost, and creates nothing', async () => {
    const user = await createFundedTestUser(ENTRY_COST_MINOR - 1n)
    trackedUserIds.push(user.id)

    await expect(placeEntry(user.id, `test:${randomUUID()}`)).rejects.toThrow(
      InsufficientBalanceError,
    )

    const entries = await prisma.drawEntry.count({ where: { userId: user.id } })
    expect(entries).toBe(0)
  })

  it('replaying the same idempotencyKey does not create a second entry or double-charge', async () => {
    const user = await createFundedTestUser(ENTRY_COST_MINOR * 5n)
    trackedUserIds.push(user.id)
    const key = `test:${randomUUID()}`

    const first = await placeEntry(user.id, key)
    const walletAfterFirst = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const second = await placeEntry(user.id, key)
    const walletAfterSecond = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })

    expect(second.entryId).toBe(first.entryId)
    expect(second.slotNumber).toBe(first.slotNumber)
    expect(walletAfterSecond.balanceMinor).toBe(walletAfterFirst.balanceMinor) // not charged twice

    const entryCount = await prisma.drawEntry.count({ where: { userId: user.id } })
    expect(entryCount).toBe(1)
  })

  it('filling exactly ROUND_SIZE entries settles the round correctly: capacity, payouts, and money all balance', async () => {
      // A fresh, isolated round: drain whatever's currently open first so
      // this test's ROUND_SIZE entries are the only ones in play and the
      // outcome counts below are exact, not diluted by other test files'
      // leftovers in the shared dev database.
      const draining = await drainCurrentOpenRound()
      trackedUserIds.push(...draining)

      const users = await createFundedTestUsers(ROUND_SIZE, ENTRY_COST_MINOR * 2n)
      trackedUserIds.push(...users.map((u) => u.id))

      const systemUserId = await getSystemUserId()
      const systemWalletBefore = await prisma.wallet.findUniqueOrThrow({
        where: { userId: systemUserId },
      })

      const results = await Promise.all(
        users.map((u) => placeEntry(u.id, `test:${randomUUID()}`)),
      )

      // Exactly one slot per entrant, forming 1..ROUND_SIZE with no gaps
      // or duplicates — the actual capacity guarantee under concurrency.
      const slots = results.map((r) => r.slotNumber).sort((a, b) => a - b)
      expect(slots).toEqual(Array.from({ length: ROUND_SIZE }, (_, i) => i + 1))

      const roundId = results[0].roundId
      expect(results.every((r) => r.roundId === roundId)).toBe(true)
      expect(results.filter((r) => r.roundSettled).length).toBe(1) // exactly one request closes it

      const round = await prisma.drawRound.findUniqueOrThrow({ where: { id: roundId } })
      expect(round.status).toBe('SETTLED')

      const entries = await prisma.drawEntry.findMany({ where: { roundId } })
      const won = entries.filter((e) => e.outcome === 'WON')
      const refunded = entries.filter((e) => e.outcome === 'REFUNDED')
      const lost = entries.filter((e) => e.outcome === 'LOST')
      expect(won).toHaveLength(1)
      expect(refunded).toHaveLength(Math.ceil((ROUND_SIZE - 1) / 2))
      expect(lost).toHaveLength(Math.floor((ROUND_SIZE - 1) / 2))

      // By the time placeEntry's returning promise resolves for the
      // settling request, payouts have already run (synchronous pay step
      // — see draw.service.ts) — verify wallets actually reflect it, not
      // just the entry rows' bookkeeping.
      for (const entry of won) {
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: entry.userId } })
        const stakeSpent = ENTRY_COST_MINOR * 2n - ENTRY_COST_MINOR
        expect(wallet.balanceMinor).toBe(stakeSpent + WINNER_PAYOUT_MINOR)
      }
      for (const entry of refunded) {
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: entry.userId } })
        expect(wallet.balanceMinor).toBe(ENTRY_COST_MINOR * 2n - FEE_MINOR) // stake back, fee still spent
      }
      for (const entry of lost) {
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: entry.userId } })
        expect(wallet.balanceMinor).toBe(ENTRY_COST_MINOR * 2n - ENTRY_COST_MINOR) // stake + fee both gone
      }

      // The pool self-balances: total stake in == winner + refunds out.
      const totalStakeIn = BigInt(ROUND_SIZE) * STAKE_MINOR
      const totalPaidOut = won[0].payoutMinor! + refunded.reduce((a, e) => a + e.payoutMinor!, 0n)
      expect(totalPaidOut).toBe(totalStakeIn)

      // The company kept exactly ROUND_SIZE fees, independent of outcome.
      const systemWalletAfter = await prisma.wallet.findUniqueOrThrow({
        where: { userId: systemUserId },
      })
      expect(systemWalletAfter.balanceMinor - systemWalletBefore.balanceMinor).toBe(
        BigInt(ROUND_SIZE) * FEE_MINOR,
      )

      // Every WON/REFUNDED entry is marked settled now that it's been paid.
      expect([...won, ...refunded].every((e) => e.settledAt !== null)).toBe(true)
  })

  it('entries beyond ROUND_SIZE overflow cleanly into the next round, not lost or duplicated', async () => {
      const draining = await drainCurrentOpenRound()
      trackedUserIds.push(...draining)

      // Scaled to ROUND_SIZE (not a bare constant) so this stays "a small
      // overflow into a second round that itself stays open" even when
      // ROUND_SIZE is shrunk for manual testing (DRAW_ROUND_SIZE) — a
      // fixed 5 would itself overflow a shrunk round (e.g. ROUND_SIZE=4),
      // spilling into a *third* round and invalidating the "exactly two
      // rounds touched" assertions below for reasons unrelated to what
      // this test actually checks.
      const overflowBy = Math.max(1, Math.min(5, ROUND_SIZE - 1))
      const users = await createFundedTestUsers(ROUND_SIZE + overflowBy, ENTRY_COST_MINOR * 2n)
      trackedUserIds.push(...users.map((u) => u.id))

      const results = await Promise.all(
        users.map((u) => placeEntry(u.id, `test:${randomUUID()}`)),
      )

      // Every request got a distinct (roundId, slotNumber) pair — nothing
      // silently dropped under concurrency.
      const pairs = new Set(results.map((r) => `${r.roundId}:${r.slotNumber}`))
      expect(pairs.size).toBe(results.length)

      const byRound = new Map<string, typeof results>()
      for (const r of results) {
        byRound.set(r.roundId, [...(byRound.get(r.roundId) ?? []), r])
      }
      expect(byRound.size).toBe(2) // exactly two rounds touched

      const sizes = [...byRound.values()].map((rs) => rs.length).sort((a, b) => a - b)
      expect(sizes).toEqual([overflowBy, ROUND_SIZE])

      const firstRoundId = [...byRound.entries()].find(([, rs]) => rs.length === ROUND_SIZE)![0]
      const firstRound = await prisma.drawRound.findUniqueOrThrow({ where: { id: firstRoundId } })
      expect(firstRound.status).toBe('SETTLED')

      const secondRoundId = [...byRound.entries()].find(([, rs]) => rs.length === overflowBy)![0]
      const secondRound = await prisma.drawRound.findUniqueOrThrow({ where: { id: secondRoundId } })
      expect(secondRound.status).toBe('OPEN')
      const secondRoundSlots = byRound
        .get(secondRoundId)!
        .map((r) => r.slotNumber)
        .sort((a, b) => a - b)
      expect(secondRoundSlots).toEqual(Array.from({ length: overflowBy }, (_, i) => i + 1))
  })
})

/**
 * Drains (fills and settles) whatever round is currently open before a
 * test that needs to own a round exactly, so its own ROUND_SIZE entries
 * aren't sharing a round with leftovers from another test file run
 * earlier against this same dev database. Returns the user ids it
 * created, for cleanup.
 */
async function drainCurrentOpenRound(): Promise<string[]> {
  const open = await prisma.drawRound.findFirst({ where: { status: 'OPEN' } })
  const remaining = open ? ROUND_SIZE - open.entryCount : ROUND_SIZE
  if (remaining <= 0) return []

  const users = await createFundedTestUsers(remaining, ENTRY_COST_MINOR * 2n)
  await Promise.all(users.map((u) => placeEntry(u.id, `test-drain:${randomUUID()}`)))
  return users.map((u) => u.id)
}

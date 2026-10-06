import type { Prisma } from '../generated/prisma/client'
import { STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../config/constants'
import { prisma, runInTransaction } from '../lib/prisma'
import { secureShuffle } from './rng'
import { credit } from './wallet.service'

/**
 * The "decide" half of the decide-then-pay split (see the plan, §3, and
 * progress.md's 2026-10-06 entry for why this was split out from the
 * original single-transaction design). Runs inside the same transaction
 * that just incremented the round's entry count to exactly ROUND_SIZE —
 * only one transaction can ever observe that transition, so this runs
 * exactly once per round, guaranteed by the round's row lock the caller
 * already holds. Does NOT touch any wallet — bookkeeping only, which is
 * what keeps this step fast regardless of round size.
 */
export async function decideSettlement(tx: Prisma.TransactionClient, roundId: string) {
  const entries = await tx.drawEntry.findMany({
    where: { roundId },
    orderBy: { slotNumber: 'asc' },
    select: { id: true },
  })

  const shuffled = secureShuffle(entries.map((e) => e.id))
  const winnerId = shuffled[0]

  // Derived from the actual entry count found, not a hardcoded 500/499 —
  // this is what lets the exact same code and formula run correctly at
  // both the real 1000-entry scale and a small scale in tests. The extra
  // one from an odd non-winner count rounds into refunded, matching the
  // confirmed business rule (of 999 non-winners at N=1000: 500 refunded,
  // 499 lost).
  const nonWinnerCount = entries.length - 1
  const refundCount = Math.ceil(nonWinnerCount / 2)
  const refundedIds = shuffled.slice(1, 1 + refundCount)
  const lostIds = shuffled.slice(1 + refundCount)

  await tx.drawEntry.update({
    where: { id: winnerId },
    data: { outcome: 'WON', payoutMinor: WINNER_PAYOUT_MINOR },
  })
  await tx.drawEntry.updateMany({
    where: { id: { in: refundedIds } },
    data: { outcome: 'REFUNDED', payoutMinor: STAKE_MINOR },
  })
  await tx.drawEntry.updateMany({
    where: { id: { in: lostIds } },
    // Lost entries need no further money movement, ever — settled now.
    data: { outcome: 'LOST', payoutMinor: 0n, settledAt: new Date() },
  })

  await tx.drawRound.update({
    where: { id: roundId },
    data: {
      status: 'SETTLED',
      winnerEntryId: winnerId,
      refundCount: refundedIds.length,
      lossCount: lostIds.length,
      settledAt: new Date(),
      shuffleAudit: {
        algorithm: 'fisher-yates-crypto-randomInt',
        shuffledEntryIds: shuffled,
        decidedAt: new Date().toISOString(),
      },
    },
  })

  // Opening the next round here, in the same transaction, right after
  // marking this one SETTLED (not before — the partial unique index
  // allows only one OPEN round, so the old one must stop being OPEN
  // before the new one can start being OPEN) — never a gap with zero
  // open rounds.
  await tx.drawRound.create({ data: {} })
}

/**
 * The "pay" half: credits the 501 winning/refunded wallets. Deliberately
 * called AFTER decideSettlement's transaction has already committed and
 * released the round lock — these 501 payouts touch 501 different
 * wallets, each with its own independent lock from wallet.service, so
 * they run concurrently instead of queuing behind one shared lock. This
 * is what actually fixes the scaling problem found in M4 (see
 * progress.md): the round lock is held only for the fast "decide" step
 * above, never for crediting money.
 *
 * Safely re-runnable: outcome IN (WON, REFUNDED) AND settledAt IS NULL
 * identifies exactly which payouts are still outstanding, and each
 * credit is idempotent (keyed to the entry id) — calling this again for
 * a round that's already fully paid is a correct no-op, which is also
 * the recovery story if a payout fails partway (crash, network blip).
 */
export async function payOutRound(roundId: string) {
  const outstanding = await prisma.drawEntry.findMany({
    where: {
      roundId,
      outcome: { in: ['WON', 'REFUNDED'] },
      settledAt: null,
    },
    select: { id: true, userId: true, outcome: true, payoutMinor: true },
  })

  const results = await Promise.allSettled(
    outstanding.map((entry) =>
      runInTransaction(async (tx) => {
        await credit(tx, {
          userId: entry.userId,
          amountMinor: entry.payoutMinor!,
          entryType: entry.outcome === 'WON' ? 'DRAW_WINNER_PAYOUT' : 'DRAW_REFUND',
          referenceType: 'DRAW_ENTRY',
          referenceId: entry.id,
          idempotencyKey: `draw_payout:${entry.id}`,
        })
        await tx.drawEntry.update({
          where: { id: entry.id },
          data: { settledAt: new Date() },
        })
      }),
    ),
  )

  const failed = results.filter((r) => r.status === 'rejected')
  return { paid: results.length - failed.length, failed: failed.length }
}

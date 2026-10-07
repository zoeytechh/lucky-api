import { randomUUID } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR } from '../config/constants'
import { prisma, runInTransaction } from '../lib/prisma'
import { notifyWalletUpdate, tryGetIo } from '../realtime/socket'
import { decideSettlement, payOutRound } from './settlement.service'
import { credit, debit, getSystemUserId } from './wallet.service'

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Insufficient wallet balance to enter the draw')
  }
}

export class AlreadyEnteredError extends Error {
  constructor() {
    super('You already have an entry in the current round')
  }
}

type RoundRow = { id: string; round_number: number; entry_count: number }

/**
 * Locks the single OPEN round (Postgres SELECT ... FOR UPDATE) — every
 * concurrent entry attempt queues on this one row and is processed
 * strictly one at a time, which is what guarantees a round can never end
 * up with more or fewer than exactly 1000 entries. If no OPEN round
 * exists at all, this is true only at the very first boot (every
 * settlement opens its own replacement round from inside the same
 * transaction that closes the old one — see settlement.service.ts — so
 * there's no ongoing race there, just this one-time startup case).
 */
async function lockOpenRound(tx: Prisma.TransactionClient): Promise<RoundRow> {
  const rows = await tx.$queryRaw<RoundRow[]>`
    SELECT id, round_number, entry_count FROM draw_rounds WHERE status = 'OPEN' FOR UPDATE
  `
  if (rows.length > 0) return rows[0]

  // First boot: create the very first round. A genuine simultaneous race
  // here (two requests, both finding zero rounds) is handled by letting
  // the loser's transaction fail outright and retrying placeEntry once
  // (see below) — simpler and safer than complex conflict-target SQL for
  // an event that happens exactly once in the application's lifetime.
  await tx.drawRound.create({ data: {} })
  const created = await tx.$queryRaw<RoundRow[]>`
    SELECT id, round_number, entry_count FROM draw_rounds WHERE status = 'OPEN' FOR UPDATE
  `
  return created[0]
}

export type PlaceEntryResult = {
  entryId: string
  slotNumber: number
  roundId: string
  roundNumber: number
  roundSettled: boolean
  winnerSlotNumber?: number
  winnerDisplayName?: string
  winnerAvatarUrl?: string | null
  nextRoundId?: string
  nextRoundNumber?: number
}

// Internal-only: lets placeEntry tell a genuine settlement apart from an
// idempotency replay of an already-settled entry, without that
// distinction leaking into the public result type above (the route
// response never needs it — it's only used here to decide whether to
// broadcast). entrantBalanceMinor is similarly internal — only present
// on a genuine (non-replay) entry, used to push a live wallet update;
// the HTTP response itself doesn't need it, the entrant's own client
// already has it via refreshWallet().
type InternalPlaceEntryResult = PlaceEntryResult & { isReplay: boolean; entrantBalanceMinor?: bigint }

type DrawEntryRow = { id: string; round_id: string; slot_number: number }
type DrawEntryRowWithKey = DrawEntryRow & { idempotency_key: string }

async function placeEntryOnce(userId: string, idempotencyKey: string): Promise<InternalPlaceEntryResult> {
  const result = await runInTransaction(async (tx) => {
    const round = await lockOpenRound(tx)

    // One entry per user per round — enforced here, inside the round's
    // own lock, so it's correct even if the same user fires two genuinely
    // different requests (different idempotencyKeys, e.g. a UI bug or a
    // deliberate double-click) at the same instant: both queue on the
    // round lock above, and only the first to actually run this check
    // finds nothing and proceeds. The frontend also disables the Enter
    // button once a user has an entry in the current round, but that's
    // just UX — this is the actual guarantee.
    const existingForUser = await tx.$queryRaw<DrawEntryRowWithKey[]>`
      SELECT id, round_id, slot_number, idempotency_key FROM draw_entries
      WHERE round_id = ${round.id} AND user_id = ${userId}
      LIMIT 1
    `
    if (existingForUser.length > 0) {
      const existing = existingForUser[0]
      if (existing.idempotency_key !== idempotencyKey) {
        throw new AlreadyEnteredError()
      }
      // Same request retried (double-tap, network retry) — safe replay,
      // same semantics as the idempotency-key conflict handled below.
      return {
        entryId: existing.id,
        slotNumber: existing.slot_number,
        roundId: existing.round_id,
        roundNumber: round.round_number,
        roundSettled: false,
        isReplay: true,
      }
    }

    const entryId = randomUUID()
    const slotNumber = round.entry_count + 1

    // Idempotency check merged into the insert itself (ON CONFLICT DO
    // NOTHING, one round trip for the common case) rather than a separate
    // findUnique before it — same reasoning as ledger.service.postLedgerEntry,
    // this is on the lock-serialized hot path where every round trip
    // compounds across however many entries are queued behind the round
    // lock. Falls back to one SELECT only on conflict (replay).
    const inserted = await tx.$queryRaw<DrawEntryRow[]>`
      INSERT INTO draw_entries (id, round_id, user_id, slot_number, stake_minor, fee_minor, idempotency_key, entered_at)
      VALUES (${entryId}, ${round.id}, ${userId}, ${slotNumber}, ${STAKE_MINOR.toString()}::bigint, ${FEE_MINOR.toString()}::bigint, ${idempotencyKey}, now())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id, round_id, slot_number
    `

    if (inserted.length === 0) {
      const existing = await tx.$queryRaw<DrawEntryRow[]>`
        SELECT id, round_id, slot_number FROM draw_entries WHERE idempotency_key = ${idempotencyKey}
      `
      if (!existing[0]) throw new Error(`Entry conflict but not found for key ${idempotencyKey}`)
      return {
        entryId: existing[0].id,
        slotNumber: existing[0].slot_number,
        roundId: existing[0].round_id,
        roundNumber: round.round_number,
        roundSettled: false, // replay — caller already got the real answer the first time
        isReplay: true,
      }
    }

    // Stake + fee debited from the entrant, fee credited to the company
    // account — three ledger rows, each idempotency-keyed off the entry
    // id so this whole operation is itself safely retryable.
    await debit(tx, {
      userId,
      amountMinor: STAKE_MINOR,
      entryType: 'DRAW_ENTRY_STAKE',
      referenceType: 'DRAW_ENTRY',
      referenceId: entryId,
      idempotencyKey: `draw_entry_stake:${entryId}`,
    })
    // Reflects the entrant's balance after both debits above (same
    // locked wallet row, applied in sequence within this transaction) —
    // carried out so the caller can push a live wallet update once this
    // transaction actually commits.
    const { balanceMinor: entrantBalanceMinor } = await debit(tx, {
      userId,
      amountMinor: FEE_MINOR,
      entryType: 'DRAW_ENTRY_FEE',
      referenceType: 'DRAW_ENTRY',
      referenceId: entryId,
      idempotencyKey: `draw_entry_fee_debit:${entryId}`,
    })
    const systemUserId = await getSystemUserId(tx)
    await credit(tx, {
      userId: systemUserId,
      amountMinor: FEE_MINOR,
      entryType: 'DRAW_ENTRY_FEE',
      referenceType: 'DRAW_ENTRY',
      referenceId: entryId,
      idempotencyKey: `draw_entry_fee_credit:${entryId}`,
    })

    await tx.drawRound.update({
      where: { id: round.id },
      data: { entryCount: { increment: 1 } },
    })

    let roundSettled = false
    let settlement: Awaited<ReturnType<typeof decideSettlement>> | undefined
    if (slotNumber === ROUND_SIZE) {
      settlement = await decideSettlement(tx, round.id)
      roundSettled = true
    }

    return {
      entryId,
      slotNumber,
      roundId: round.id,
      roundNumber: round.round_number,
      roundSettled,
      winnerSlotNumber: settlement?.winnerSlotNumber,
      winnerDisplayName: settlement?.winnerDisplayName,
      winnerAvatarUrl: settlement?.winnerAvatarUrl,
      nextRoundId: settlement?.nextRoundId,
      nextRoundNumber: settlement?.nextRoundNumber,
      isReplay: false,
      entrantBalanceMinor,
    }
  })

  return result
}

/**
 * Entry point for placing a draw entry. Debits ENTRY_COST_MINOR (stake +
 * fee) from the user's wallet; throws InsufficientBalanceError first if
 * the wallet can't cover it (checked before touching the round lock, so
 * an entrant who can't afford it never queues other entrants behind a
 * doomed transaction). Paying out a settled round (crediting the 501
 * winners) happens separately, after this returns — see
 * settlement.service.payOutRound — deliberately outside the round lock,
 * per the M4 concurrency finding documented in the plan and progress.md.
 */
export async function placeEntry(userId: string, idempotencyKey: string): Promise<PlaceEntryResult> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } })
  if (!wallet || wallet.balanceMinor < ENTRY_COST_MINOR) {
    throw new InsufficientBalanceError()
  }

  let result: InternalPlaceEntryResult
  try {
    result = await placeEntryOnce(userId, idempotencyKey)
  } catch (err) {
    // AlreadyEnteredError is a genuine rejection, not a transient race —
    // retrying would just throw the same error again.
    if (err instanceof AlreadyEnteredError) throw err
    // The only expected failure mode here is the first-boot round-creation
    // race described in lockOpenRound — retry once, by which point the
    // round the other transaction created is visible.
    const roundExists = (await prisma.drawRound.count({ where: { status: 'OPEN' } })) > 0
    if (!roundExists) throw err
    result = await placeEntryOnce(userId, idempotencyKey)
  }

  // Broadcast only for a genuinely fresh entry — a replay (idempotency
  // hit) means nothing new actually happened, so there's nothing to tell
  // other viewers. Emitted after the transaction has already committed
  // (never from inside one that could still roll back) — same rule
  // payOutRound follows below.
  const io = tryGetIo()

  if (!result.isReplay) {
    if (result.entrantBalanceMinor !== undefined) {
      notifyWalletUpdate(userId, result.entrantBalanceMinor)
    }
    io?.emit('round:progress', {
      roundId: result.roundId,
      roundNumber: result.roundNumber,
      entryCount: result.slotNumber,
      capacity: ROUND_SIZE,
    })
  }

  if (result.roundSettled) {
    io?.emit('round:settled', {
      roundId: result.roundId,
      roundNumber: result.roundNumber,
      winnerSlotNumber: result.winnerSlotNumber,
      winnerDisplayName: result.winnerDisplayName,
      winnerAvatarUrl: result.winnerAvatarUrl,
      nextRoundId: result.nextRoundId,
      nextRoundNumber: result.nextRoundNumber,
    })

    // Outside the round lock entirely — see payOutRound's own comment.
    // Not swallowed silently: logged so a failed payout (whole-batch, or
    // individual payouts within it) is visible and can be retried
    // (payOutRound is safely re-runnable) rather than discovered only
    // when a user notices their wallet is short.
    try {
      const { paid, failed } = await payOutRound(result.roundId)
      if (failed > 0) {
        console.error(`Round ${result.roundId}: ${failed} of ${paid + failed} payouts failed — retry payOutRound for this round`)
      }
    } catch (err) {
      console.error(`payOutRound failed outright for round ${result.roundId}:`, err)
    }
  }

  return result
}

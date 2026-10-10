import { randomUUID } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../config/constants'
import { prisma, runInTransaction } from '../lib/prisma'
import { notifyWalletUpdate, tryGetIo } from '../realtime/socket'
import { notifyInactiveNonParticipants, sendPushToUserIds } from './push.service'
import { decideSettlement, payOutRound } from './settlement.service'
import { credit, debit, getSystemUserId } from './wallet.service'

// Push notification text only needs a quick, human-readable amount —
// not the same precision/locale handling the frontend's formatNaira
// does for on-screen display, so a small inline helper here rather than
// a shared module for one use site.
function formatNairaForPush(amountMinor: string): string {
  return `₦${(Number(amountMinor) / 100).toLocaleString('en-NG')}`
}

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

// Thrown when the open round exists but hasn't started accepting
// entries yet — the previous round's reveal is still playing out for
// everyone watching it. See DrawRound.entriesOpenAt's schema comment.
export class DrawInProgressError extends Error {
  entriesOpenAt: Date
  constructor(entriesOpenAt: Date) {
    super('The current draw is still revealing its winner — try again in a moment')
    this.entriesOpenAt = entriesOpenAt
  }
}

type RoundRow = { id: string; round_number: number; entry_count: number; entries_open_at: Date }

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
    SELECT id, round_number, entry_count, entries_open_at FROM draw_rounds WHERE status = 'OPEN' FOR UPDATE
  `
  if (rows.length > 0) return rows[0]

  // First boot: create the very first round. A genuine simultaneous race
  // here (two requests, both finding zero rounds) is handled by letting
  // the loser's transaction fail outright and retrying placeEntry once
  // (see below) — simpler and safer than complex conflict-target SQL for
  // an event that happens exactly once in the application's lifetime.
  await tx.drawRound.create({ data: {} })
  const created = await tx.$queryRaw<RoundRow[]>`
    SELECT id, round_number, entry_count, entries_open_at FROM draw_rounds WHERE status = 'OPEN' FOR UPDATE
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
  winnerPayoutMinor?: string
  revealAt?: Date
  nextRoundId?: string
  nextRoundNumber?: number
  nextEntriesOpenAt?: Date
}

// Internal-only: lets placeEntry tell a genuine settlement apart from an
// idempotency replay of an already-settled entry, without that
// distinction leaking into the public result type above (the route
// response never needs it — it's only used here to decide whether to
// broadcast). entrantBalanceMinor is similarly internal — only present
// on a genuine (non-replay) entry, used to push a live wallet update;
// the HTTP response itself doesn't need it, the entrant's own client
// already has it via refreshWallet(). winnerUserId is internal for the
// same reason: needed here to target the winner's own push notification
// separately from everyone else's, but not something the HTTP response
// needs to carry.
type InternalPlaceEntryResult = PlaceEntryResult & {
  isReplay: boolean
  entrantBalanceMinor?: bigint
  winnerUserId?: string
}

type DrawEntryRow = { id: string; round_id: string; slot_number: number }
type DrawEntryRowWithKey = DrawEntryRow & { idempotency_key: string }

async function placeEntryOnce(userId: string, idempotencyKey: string): Promise<InternalPlaceEntryResult> {
  const result = await runInTransaction(async (tx) => {
    const round = await lockOpenRound(tx)

    // Refused inside the same lock that serializes every other entry
    // into this round — the previous round's reveal is still playing
    // out for everyone watching it, and this round isn't open for
    // entries until that concludes (see entries_open_at's schema
    // comment). A genuine rejection, not a transient race — placeEntry's
    // outer retry-once logic explicitly skips retrying it, same as
    // AlreadyEnteredError.
    if (round.entries_open_at > new Date()) {
      throw new DrawInProgressError(round.entries_open_at)
    }

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
      winnerPayoutMinor: settlement ? WINNER_PAYOUT_MINOR.toString() : undefined,
      winnerUserId: settlement?.winnerUserId,
      revealAt: settlement?.revealAt,
      nextRoundId: settlement?.nextRoundId,
      nextRoundNumber: settlement?.nextRoundNumber,
      nextEntriesOpenAt: settlement?.nextEntriesOpenAt,
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
    // AlreadyEnteredError and DrawInProgressError are genuine rejections,
    // not a transient race — retrying would just throw the same error
    // again (the round lock already serialized this check against every
    // other concurrent attempt).
    if (err instanceof AlreadyEnteredError || err instanceof DrawInProgressError) throw err
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

    // "Almost full" — whichever's earlier of one slot left or 90% full
    // (same formula the frontend uses for the in-app toast; see
    // DrawSocketContext). slotNumber strictly increases by exactly 1 per
    // entry within a round, so this threshold is crossed by exactly one
    // entry, ever — no separate per-round dedupe needed the way the
    // frontend's does (that one also has to handle a page reload
    // re-discovering an already-passed threshold, which this doesn't).
    //
    // Sent to every subscriber, not just the ones outside the round —
    // but with different content depending on which: someone already in
    // doesn't need "join now", they need "it's about to start". Always
    // sent as a real push either way; whether an OS popup actually shows
    // for a given recipient is the service worker's own call (src/sw.ts)
    // — if that device currently has the app open, it suppresses the
    // popup and trusts the in-app toast that same live page is already
    // showing (Draw.tsx/DrawSocketContext), rather than double-notifying.
    const almostFullThreshold = Math.min(ROUND_SIZE - 1, Math.floor(ROUND_SIZE * 0.9))
    if (!result.roundSettled && result.slotNumber === almostFullThreshold) {
      ;(async () => {
        try {
          const entrants = await prisma.drawEntry.findMany({
            where: { roundId: result.roundId },
            select: { userId: true },
          })
          const entrantIds = entrants.map((e) => e.userId)

          if (entrantIds.length > 0) {
            await sendPushToUserIds(entrantIds, {
              title: 'Draw about to start',
              body: `Round ${result.roundNumber} is filling up — the draw starts soon.`,
              url: '/',
            })
          }

          const allSubscriberIds = (
            await prisma.pushSubscription.findMany({ select: { userId: true }, distinct: ['userId'] })
          ).map((s) => s.userId)
          const nonEntrantIds = allSubscriberIds.filter((id) => !entrantIds.includes(id))
          if (nonEntrantIds.length > 0) {
            await sendPushToUserIds(nonEntrantIds, {
              title: 'Almost full!',
              body: `Round ${result.roundNumber} is at ${result.slotNumber} of ${ROUND_SIZE} — join now before it closes.`,
              url: '/',
            })
          }
        } catch (err) {
          console.error('almost-full push failed:', err)
        }
      })()
    }
  }

  if (result.roundSettled) {
    io?.emit('round:settled', {
      roundId: result.roundId,
      roundNumber: result.roundNumber,
      winnerSlotNumber: result.winnerSlotNumber,
      winnerDisplayName: result.winnerDisplayName,
      winnerAvatarUrl: result.winnerAvatarUrl,
      winnerPayoutMinor: result.winnerPayoutMinor,
      revealAt: result.revealAt,
      nextRoundId: result.nextRoundId,
      nextRoundNumber: result.nextRoundNumber,
      nextEntriesOpenAt: result.nextEntriesOpenAt,
    })

    // Only round participants get told who won — not every subscriber,
    // the way the almost-full nudge works. The one exception is a user
    // who hasn't played in 24h+ (notifyInactiveNonParticipants): they
    // still get told once per inactive stretch, as a hook back into the
    // app, even though this round wasn't theirs. Best-effort throughout:
    // a failed push send should never fail the entry request that
    // triggered it (already committed and responded to by this point in
    // every real sense that matters).
    //
    // Delayed until revealAt, not sent immediately — the winner is
    // *decided* here, but every in-app viewer (the ring, the modal) only
    // finds out at the server's own revealAt, 30-59s later. Sending the
    // push the instant this runs spoiled that: the winner got "You won!"
    // while their own ring was still mid-suspense, before the reveal
    // they were watching had even happened. A plain setTimeout, not a
    // persisted job — same tradeoff the reveal delay itself already
    // makes client-side; REVEAL_MAX_MS tops out under a minute, so a
    // mid-window server restart losing a push is an acceptable, rare
    // edge rather than something worth a durable scheduler for.
    if (result.winnerUserId && result.winnerPayoutMinor && result.revealAt) {
      const amount = formatNairaForPush(result.winnerPayoutMinor)
      const delayMs = Math.max(0, result.revealAt.getTime() - Date.now())
      const roundId = result.roundId
      const winnerUserId = result.winnerUserId
      setTimeout(async () => {
        try {
          sendPushToUserIds([winnerUserId], {
            title: 'You won! 🎉',
            body: `Congratulations — you just won ${amount} in Round ${result.roundNumber}.`,
            url: '/',
          }).catch((err) => console.error('sendPushToUserIds (winner) failed:', err))

          const entrants = await prisma.drawEntry.findMany({
            where: { roundId },
            select: { userId: true },
          })
          const participantIds = entrants.map((e) => e.userId).filter((id) => id !== winnerUserId)
          const announcement = {
            title: 'We have a winner',
            body: `${result.winnerDisplayName} just won ${amount} in Round ${result.roundNumber}.`,
            url: '/',
          }

          if (participantIds.length > 0) {
            await sendPushToUserIds(participantIds, announcement)
          }
          await notifyInactiveNonParticipants([winnerUserId, ...participantIds], announcement)
        } catch (err) {
          console.error('settled push failed:', err)
        }
      }, delayMs)
    }

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

  // Explicit public shape, not the raw internal `result` — it carries
  // isReplay and entrantBalanceMinor (a real bigint), neither meant to
  // leave this function. Returning `result` directly here previously let
  // that bigint reach res.json() in draw.routes.ts, which throws ("Do
  // not know how to serialize a BigInt") since JSON has no bigint
  // representation — broke every single non-replay entry the moment
  // entrantBalanceMinor started being set, caught live.
  return {
    entryId: result.entryId,
    slotNumber: result.slotNumber,
    roundId: result.roundId,
    roundNumber: result.roundNumber,
    roundSettled: result.roundSettled,
    winnerSlotNumber: result.winnerSlotNumber,
    winnerDisplayName: result.winnerDisplayName,
    winnerAvatarUrl: result.winnerAvatarUrl,
    revealAt: result.revealAt,
    nextRoundId: result.nextRoundId,
    nextRoundNumber: result.nextRoundNumber,
    nextEntriesOpenAt: result.nextEntriesOpenAt,
  }
}

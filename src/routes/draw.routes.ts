import { Router } from 'express'
import { z } from 'zod'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../config/constants'
import { displayNameFor } from '../lib/displayName'
import { prisma } from '../lib/prisma'
import { requireAuth, requireCompleteProfile } from '../middleware/auth'
import { AlreadyEnteredError, InsufficientBalanceError, placeEntry } from '../services/draw.service'

const router = Router()

router.use(requireAuth, requireCompleteProfile)

router.get('/current', async (_req, res) => {
  const round = await prisma.drawRound.findFirst({ where: { status: 'OPEN' } })
  res.json({
    roundId: round?.id ?? null,
    roundNumber: round?.roundNumber ?? null,
    entryCount: round?.entryCount ?? 0,
    capacity: ROUND_SIZE,
    entryCostMinor: ENTRY_COST_MINOR.toString(),
    stakeMinor: STAKE_MINOR.toString(),
    feeMinor: FEE_MINOR.toString(),
    winnerPayoutMinor: WINNER_PAYOUT_MINOR.toString(),
  })
})

const enterSchema = z.object({ idempotencyKey: z.string().min(10) })

router.post('/entries', async (req, res) => {
  const parsed = enterSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', code: 'VALIDATION_ERROR' })
  }

  try {
    const result = await placeEntry(req.user!.id, parsed.data.idempotencyKey)
    res.json(result)
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return res.status(402).json({ message: err.message, code: 'INSUFFICIENT_BALANCE' })
    }
    if (err instanceof AlreadyEnteredError) {
      return res.status(409).json({ message: err.message, code: 'ALREADY_ENTERED' })
    }
    throw err
  }
})

// Lets the frontend reveal who won a specific round once it's settled —
// needed because /current always reflects the round that's open *now*
// (a new one, opened the instant the old one settled), so there's no way
// to ask "who won the round I was just watching" from that endpoint alone.
router.get('/rounds/:roundId', async (req, res) => {
  const round = await prisma.drawRound.findUnique({ where: { id: req.params.roundId } })
  if (!round) return res.status(404).json({ message: 'Round not found', code: 'NOT_FOUND' })

  const winnerEntry = round.winnerEntryId
    ? await prisma.drawEntry.findUnique({
        where: { id: round.winnerEntryId },
        select: { slotNumber: true },
      })
    : null

  res.json({
    roundId: round.id,
    roundNumber: round.roundNumber,
    status: round.status,
    entryCount: round.entryCount,
    capacity: ROUND_SIZE,
    winnerSlotNumber: winnerEntry?.slotNumber ?? null,
    settledAt: round.settledAt,
  })
})

router.get('/entries', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50)
  const entries = await prisma.drawEntry.findMany({
    where: { userId: req.user!.id },
    orderBy: { enteredAt: 'desc' },
    take: limit,
  })

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      slotNumber: e.slotNumber,
      outcome: e.outcome,
      payoutMinor: e.payoutMinor?.toString() ?? null,
      enteredAt: e.enteredAt,
      settledAt: e.settledAt,
    })),
  })
})

// Shared by /recent-entries and /winners: both are numbered-page feeds
// (not "load more" accumulation) so a far-back page is one bounded
// request, not N pages' worth of rows sitting in memory — relevant once
// this is doing ~100 rounds/day and history keeps growing indefinitely.
function pagination(req: { query: Record<string, unknown> }, defaultPageSize: number) {
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || defaultPageSize, 1), 100)
  const page = Math.max(Number(req.query.page) || 1, 1)
  return { page, pageSize, skip: (page - 1) * pageSize }
}

// The caller's own entries only — not a global feed. Used both for the
// small inline "recent entries" widget on the Draw page (page size 3, no
// pagination controls) and the dedicated /draw/recent page (page size
// 20, numbered pagination).
router.get('/recent-entries', async (req, res) => {
  const { page, pageSize, skip } = pagination(req, 20)
  const where = { userId: req.user!.id }

  const [entries, total] = await Promise.all([
    prisma.drawEntry.findMany({
      where,
      orderBy: { enteredAt: 'desc' },
      take: pageSize,
      skip,
      include: {
        user: { select: { id: true, fullName: true, phoneNumber: true } },
        round: { select: { roundNumber: true, openedAt: true } },
      },
    }),
    prisma.drawEntry.count({ where }),
  ])

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      roundNumber: e.round.roundNumber,
      roundDate: e.round.openedAt,
      slotNumber: e.slotNumber,
      outcome: e.outcome,
      payoutMinor: e.payoutMinor?.toString() ?? null,
      enteredAt: e.enteredAt,
      user: { id: e.user.id, displayName: displayNameFor(e.user) },
    })),
    page,
    pageSize,
    total,
  })
})

// Past winners only (outcome = WON), across every round — the dedicated
// /draw/winners page, page size 20 (same as /recent-entries), numbered
// pagination requesting a fresh page from the backend rather than
// accumulating everything client-side.
router.get('/winners', async (req, res) => {
  const { page, pageSize, skip } = pagination(req, 20)

  const [entries, total] = await Promise.all([
    prisma.drawEntry.findMany({
      where: { outcome: 'WON' },
      // enteredAt, not settledAt — settledAt is set by the payout step
      // slightly after settlement and (rarely) could still be null if a
      // payout failed outright, which would sort unpredictably.
      orderBy: { enteredAt: 'desc' },
      take: pageSize,
      skip,
      include: {
        user: { select: { id: true, fullName: true, phoneNumber: true } },
        round: { select: { roundNumber: true, openedAt: true } },
      },
    }),
    prisma.drawEntry.count({ where: { outcome: 'WON' } }),
  ])

  res.json({
    winners: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      roundNumber: e.round.roundNumber,
      roundDate: e.round.openedAt,
      slotNumber: e.slotNumber,
      payoutMinor: e.payoutMinor?.toString() ?? null,
      settledAt: e.settledAt,
      user: { id: e.user.id, displayName: displayNameFor(e.user) },
    })),
    page,
    pageSize,
    total,
  })
})

export default router

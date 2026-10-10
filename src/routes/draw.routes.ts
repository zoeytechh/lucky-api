import { Router } from 'express'
import { z } from 'zod'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../config/constants'
import { displayNameFor } from '../lib/displayName'
import { prisma } from '../lib/prisma'
import { requireAuth, requireCompleteProfile } from '../middleware/auth'
import {
  AlreadyEnteredError,
  DrawInProgressError,
  InsufficientBalanceError,
  placeEntry,
} from '../services/draw.service'

const router = Router()

router.use(requireAuth, requireCompleteProfile)

// Only one round is ever "in play" from a viewer's point of view — the
// open round's own entriesOpenAt (see the schema comment on DrawRound)
// stays in the future for as long as the *previous* round's reveal is
// still playing out, so a client that just loaded the page mid-reveal
// would otherwise see a blank, empty "next" round and miss it entirely.
// When that's the case, this also looks up that previous (now SETTLED)
// round and returns it as `drawing` — everything the frontend needs to
// render the exact same suspense/reveal a viewer who was already
// connected sees, synced to the same server-decided revealAt. `drawing`
// is null the rest of the time (the normal case: the open round is
// already accepting entries).
router.get('/current', async (_req, res) => {
  const round = await prisma.drawRound.findFirst({ where: { status: 'OPEN' } })

  let drawing = null
  if (round && round.entriesOpenAt > new Date()) {
    const previous = await prisma.drawRound.findFirst({
      where: { status: 'SETTLED' },
      orderBy: { settledAt: 'desc' },
    })
    if (previous?.winnerEntryId) {
      const winnerEntry = await prisma.drawEntry.findUnique({
        where: { id: previous.winnerEntryId },
        select: { slotNumber: true, user: { select: { fullName: true, phoneNumber: true, avatarUrl: true } } },
      })
      if (winnerEntry) {
        drawing = {
          roundId: previous.id,
          roundNumber: previous.roundNumber,
          winnerSlotNumber: winnerEntry.slotNumber,
          winnerDisplayName: displayNameFor(winnerEntry.user),
          winnerAvatarUrl: winnerEntry.user.avatarUrl,
          revealAt: previous.revealAt,
        }
      }
    }
  }

  res.json({
    roundId: round?.id ?? null,
    roundNumber: round?.roundNumber ?? null,
    entryCount: round?.entryCount ?? 0,
    capacity: ROUND_SIZE,
    entryCostMinor: ENTRY_COST_MINOR.toString(),
    stakeMinor: STAKE_MINOR.toString(),
    feeMinor: FEE_MINOR.toString(),
    winnerPayoutMinor: WINNER_PAYOUT_MINOR.toString(),
    entriesOpenAt: round?.entriesOpenAt ?? null,
    drawing,
  })
})

// The single most recently settled round's winner, regardless of whether
// its reveal window is still active — unlike /current's `drawing`, which
// is deliberately null once entriesOpenAt passes. Used only by the
// frontend's app-wide winner notification (DrawSocketContext) to catch a
// viewer up on a result they missed entirely (app closed/backgrounded
// through the whole reveal), not by anything that gates entries.
router.get('/last-settled', async (_req, res) => {
  const round = await prisma.drawRound.findFirst({
    where: { status: 'SETTLED' },
    orderBy: { settledAt: 'desc' },
  })
  if (!round?.winnerEntryId) return res.json({ result: null })

  const winnerEntry = await prisma.drawEntry.findUnique({
    where: { id: round.winnerEntryId },
    select: {
      slotNumber: true,
      payoutMinor: true,
      user: { select: { fullName: true, phoneNumber: true, avatarUrl: true } },
    },
  })
  if (!winnerEntry) return res.json({ result: null })

  res.json({
    result: {
      roundId: round.id,
      roundNumber: round.roundNumber,
      winnerSlotNumber: winnerEntry.slotNumber,
      winnerDisplayName: displayNameFor(winnerEntry.user),
      winnerAvatarUrl: winnerEntry.user.avatarUrl,
      payoutMinor: winnerEntry.payoutMinor?.toString() ?? null,
      settledAt: round.settledAt,
    },
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
    if (err instanceof DrawInProgressError) {
      return res
        .status(423)
        .json({ message: err.message, code: 'DRAW_IN_PROGRESS', entriesOpenAt: err.entriesOpenAt })
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
        round: { select: { roundNumber: true } },
      },
    }),
    prisma.drawEntry.count({ where }),
  ])

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      roundNumber: e.round.roundNumber,
      // The entry's own timestamp, not the round's — a round can stay
      // open across a day boundary, so round.openedAt could show the
      // wrong calendar day for an entry placed after midnight.
      roundDate: e.enteredAt,
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
        round: { select: { roundNumber: true } },
      },
    }),
    prisma.drawEntry.count({ where: { outcome: 'WON' } }),
  ])

  res.json({
    winners: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      roundNumber: e.round.roundNumber,
      // The entry's own timestamp, not the round's — a round can stay
      // open across a day boundary, so round.openedAt could show the
      // wrong calendar day for an entry placed after midnight.
      roundDate: e.enteredAt,
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

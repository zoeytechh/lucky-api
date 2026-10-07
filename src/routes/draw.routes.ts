import { Router } from 'express'
import { z } from 'zod'
import { ENTRY_COST_MINOR, FEE_MINOR, ROUND_SIZE, STAKE_MINOR, WINNER_PAYOUT_MINOR } from '../config/constants'
import { prisma } from '../lib/prisma'
import { requireAuth, requireCompleteProfile } from '../middleware/auth'
import { InsufficientBalanceError, placeEntry } from '../services/draw.service'

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

// Masks everything but the last 4 digits so a public feed ("who's
// entering") never exposes a full phone number — fullName is optional at
// signup (only avatarUrl is gated by requireCompleteProfile), so most
// entrants fall back to this.
function displayNameFor(user: { fullName: string | null; phoneNumber: string }): string {
  if (user.fullName) return user.fullName
  return `•••${user.phoneNumber.slice(-4)}`
}

// Global feed (every user's entries, not just the caller's) so entrants
// can see who else is in the round — used both for the small inline
// "recent entries" widget (small `limit`) and the dedicated "view all"
// page (larger `limit` + `offset` paging).
router.get('/recent-entries', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 3, 100)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const entries = await prisma.drawEntry.findMany({
    orderBy: { enteredAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      user: { select: { id: true, fullName: true, phoneNumber: true } },
      round: { select: { roundNumber: true } },
    },
  })

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      roundId: e.roundId,
      roundNumber: e.round.roundNumber,
      slotNumber: e.slotNumber,
      outcome: e.outcome,
      payoutMinor: e.payoutMinor?.toString() ?? null,
      enteredAt: e.enteredAt,
      user: { id: e.user.id, displayName: displayNameFor(e.user) },
    })),
  })
})

export default router

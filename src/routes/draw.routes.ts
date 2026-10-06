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

export default router

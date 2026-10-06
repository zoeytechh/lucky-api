import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { requireAuth, requireCompleteProfile } from '../middleware/auth'
import { getOrCreateWallet } from '../services/wallet.service'

const router = Router()

router.use(requireAuth, requireCompleteProfile)

router.get('/', async (req, res) => {
  const wallet = await getOrCreateWallet(prisma, req.user!.id)
  res.json({
    balanceMinor: wallet.balanceMinor.toString(),
    currency: wallet.currency,
  })
})

router.get('/transactions', async (req, res) => {
  const wallet = await getOrCreateWallet(prisma, req.user!.id)
  const limit = Math.min(Number(req.query.limit) || 20, 100)

  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  res.json({
    transactions: entries.map((e) => ({
      id: e.id,
      amountMinor: e.amountMinor.toString(),
      entryType: e.entryType,
      balanceAfterMinor: e.balanceAfterMinor.toString(),
      createdAt: e.createdAt,
    })),
  })
})

export default router

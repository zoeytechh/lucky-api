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

// Numbered pages, not a flat limit — same reasoning as draw.routes.ts's
// own pagination() helper: a far-back page is one bounded request, not
// everything-so-far sitting in memory, once a wallet has months of
// entries behind it.
router.get('/transactions', async (req, res) => {
  const wallet = await getOrCreateWallet(prisma, req.user!.id)
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100)
  const page = Math.max(Number(req.query.page) || 1, 1)
  const skip = (page - 1) * pageSize

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip,
    }),
    prisma.ledgerEntry.count({ where: { walletId: wallet.id } }),
  ])

  res.json({
    transactions: entries.map((e) => ({
      id: e.id,
      amountMinor: e.amountMinor.toString(),
      entryType: e.entryType,
      balanceAfterMinor: e.balanceAfterMinor.toString(),
      createdAt: e.createdAt,
    })),
    page,
    pageSize,
    total,
  })
})

export default router

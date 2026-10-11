import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { displayNameFor } from '../lib/displayName'
import { normalizeNigerianPhone } from '../lib/phone'
import { prisma, runInTransaction } from '../lib/prisma'
import { requireAdmin, requireAuth } from '../middleware/auth'
import { InsufficientFundsError } from '../services/ledger.service'
import { credit, debit, getSystemUserId, getSystemWallet } from '../services/wallet.service'

// There's no self-service way to become an ADMIN — the role exists in
// the schema but nothing in the app ever assigns it. The three admins
// for this app were set directly in the database by hand; a future
// admin-management UI (if one's ever needed) would be its own,
// admin-gated feature, not something to build ahead of actually needing
// more than three fixed accounts.
const router = Router()

router.use(requireAuth, requireAdmin)

// The company revenue wallet (₦200 entry fees land here automatically,
// see draw.service.ts) — this is the one place fees can currently be
// spent back out, since neither leaderboard prizes nor any other manual
// payout has a different source.
router.get('/wallet', async (_req, res) => {
  const wallet = await getSystemWallet()
  res.json({ balanceMinor: wallet.balanceMinor.toString(), currency: wallet.currency })
})

// Every outbound manual payment this route has ever sent, newest first —
// an audit trail for what the SYSTEM wallet's balance actually went to.
// Only negative (outbound) LEADERBOARD_PRIZE entries on the SYSTEM
// wallet qualify; the recipient's own name is resolved via
// referenceId, which this route sets to the recipient's user id.
router.get('/sends', async (_req, res) => {
  const wallet = await getSystemWallet()
  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id, entryType: 'LEADERBOARD_PRIZE', amountMinor: { lt: 0n } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const recipientIds = [...new Set(entries.map((e) => e.referenceId).filter((id): id is string => !!id))]
  const recipients = await prisma.user.findMany({
    where: { id: { in: recipientIds } },
    select: { id: true, fullName: true, phoneNumber: true },
  })
  const recipientById = new Map(recipients.map((u) => [u.id, u]))

  res.json({
    sends: entries.map((e) => {
      const recipient = e.referenceId ? recipientById.get(e.referenceId) : undefined
      return {
        id: e.id,
        amountMinor: (-e.amountMinor).toString(),
        recipient: recipient ? displayNameFor(recipient) : 'Unknown',
        note: (e.metadata as { note?: string } | null)?.note ?? null,
        createdAt: e.createdAt,
      }
    }),
  })
})

const sendSchema = z.object({
  phoneNumber: z.string().min(7),
  amountMinor: z.number().int().positive(),
  note: z.string().max(200).optional(),
})

// A manual, one-off transfer out of the SYSTEM wallet to any user —
// built specifically to cover the daily leaderboard prize (no automated
// job exists for that yet, see progress.md), but equally usable for any
// other ad-hoc payout an admin needs to make. Both sides of the movement
// happen in one transaction via the same debit()/credit() primitives
// every other wallet movement in the app already goes through, so this
// gets the same row-locking and ledger-correctness guarantees for free.
router.post('/send', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', code: 'VALIDATION_ERROR' })
  }

  const phone = normalizeNigerianPhone(parsed.data.phoneNumber)
  if (!phone) {
    return res.status(400).json({ message: 'Invalid phone number', code: 'INVALID_PHONE' })
  }

  const recipient = await prisma.user.findUnique({ where: { phoneNumber: phone } })
  if (!recipient) {
    return res.status(404).json({ message: 'No user with that phone number', code: 'NOT_FOUND' })
  }

  try {
    const movementId = randomUUID()
    const result = await runInTransaction(async (tx) => {
      const systemUserId = await getSystemUserId(tx)
      await debit(tx, {
        userId: systemUserId,
        amountMinor: BigInt(parsed.data.amountMinor),
        entryType: 'LEADERBOARD_PRIZE',
        referenceType: 'ADMIN_SEND',
        referenceId: recipient.id,
        idempotencyKey: `admin-send-debit:${movementId}`,
        metadata: parsed.data.note ? { note: parsed.data.note } : undefined,
      })
      const { balanceMinor } = await credit(tx, {
        userId: recipient.id,
        amountMinor: BigInt(parsed.data.amountMinor),
        entryType: 'LEADERBOARD_PRIZE',
        referenceType: 'ADMIN_SEND',
        referenceId: systemUserId,
        idempotencyKey: `admin-send-credit:${movementId}`,
        metadata: parsed.data.note ? { note: parsed.data.note } : undefined,
      })
      return { recipientBalanceMinor: balanceMinor }
    })
    res.json({ sent: true, recipientBalanceMinor: result.recipientBalanceMinor.toString() })
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return res.status(402).json({ message: 'SYSTEM wallet balance too low', code: 'INSUFFICIENT_FUNDS' })
    }
    throw err
  }
})

export default router

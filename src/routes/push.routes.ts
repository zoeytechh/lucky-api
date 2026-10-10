import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { removePushSubscription, savePushSubscription } from '../services/push.service'

const router = Router()

// Public — the frontend needs this before a user is necessarily logged
// in (it's read once, at subscribe time, which only ever happens after
// auth anyway, but there's no reason to gate the key itself).
router.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null })
})

router.use(requireAuth)

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

router.post('/subscribe', async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid subscription', code: 'VALIDATION_ERROR' })
  }
  await savePushSubscription(req.user!.id, parsed.data)
  res.json({ ok: true })
})

// No userId check — an endpoint can only ever belong to one browser's
// own subscription, and removing a stale/unwanted one is harmless even
// if called by someone other than who originally subscribed it (there's
// no sensitive data in a push subscription row beyond "this device gets
// notified").
router.post('/unsubscribe', async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null
  if (endpoint) await removePushSubscription(endpoint)
  res.json({ ok: true })
})

export default router

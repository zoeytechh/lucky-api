import { Router } from 'express'
import { requireAuth, requireCompleteProfile } from '../middleware/auth'
import { listRecentComments, MAX_RECENT_COMMENTS } from '../services/comment.service'

const router = Router()

router.use(requireAuth, requireCompleteProfile)

// One-time backfill for a client that just connected/refreshed — live
// updates after that arrive over the /comments socket namespace
// (comment:new), not by polling this again.
router.get('/recent', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || MAX_RECENT_COMMENTS, MAX_RECENT_COMMENTS)
  const comments = await listRecentComments(limit)
  res.json({ comments })
})

export default router

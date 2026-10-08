import cron from 'node-cron'
import { notifyCommentsExpired } from '../realtime/socket'
import { expireOldComments } from '../services/comment.service'

// Each comment is deleted individually, 24h after it was posted — not a
// fixed daily wipe (that gave a comment posted at 11:59pm a minute of
// life and one posted at 12:01am nearly a full day, and deleted a live
// conversation out from under anyone watching at that instant). Checked
// every 15 minutes: frequent enough that "24h is up" and "actually
// deleted" never drift far apart, infrequent enough not to hammer the
// database for what is a low-volume, non-financial table.
export function scheduleCommentExpiry() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const ids = await expireOldComments()
      if (ids.length > 0) {
        notifyCommentsExpired(ids)
        console.log(`Comment expiry: removed ${ids.length} comment(s) older than 24h`)
      }
    } catch (err) {
      console.error('Comment expiry failed:', err)
    }
  })
}

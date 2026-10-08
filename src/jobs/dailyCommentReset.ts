import cron from 'node-cron'
import { notifyCommentsCleared } from '../realtime/socket'
import { purgeAllComments } from '../services/comment.service'

// Every day at midnight WAT (Nigeria has no DST, so this is a fixed
// UTC+1 offset in practice, but naming the IANA zone keeps it correct if
// that ever changes) the comment feed is wiped clean. Comments aren't
// part of the money ledger — there's no reason to keep them past the day
// they were posted, and the user explicitly asked for a fresh feed daily
// rather than an ever-growing one.
export function scheduleDailyCommentReset() {
  cron.schedule(
    '0 0 * * *',
    async () => {
      try {
        const count = await purgeAllComments()
        notifyCommentsCleared()
        console.log(`Daily comment reset: cleared ${count} comment(s)`)
      } catch (err) {
        console.error('Daily comment reset failed:', err)
      }
    },
    { timezone: 'Africa/Lagos' },
  )
}

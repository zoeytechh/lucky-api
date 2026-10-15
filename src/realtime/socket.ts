import type { Server as HttpServer } from 'node:http'
import { createAdapter } from '@socket.io/redis-adapter'
import { Redis } from 'ioredis'
import { Server, type Socket } from 'socket.io'
import { assertCompleteProfile, ProfileIncompleteError, resolveUserFromToken } from '../middleware/auth'
import {
  CommentRateLimitError,
  CommentReplyNotFoundError,
  CommentValidationError,
  createComment,
} from '../services/comment.service'
import { sendPushToUserIds } from '../services/push.service'

let io: Server | null = null

type PostAck = (res: { ok: true } | { ok: false; code: string; message: string }) => void

/**
 * Shared by every authenticated namespace (/comments, /wallet) — same
 * JWT handshake + mandatory-avatar-and-name gate as requireAuth +
 * requireCompleteProfile on the REST side, just with no Express
 * middleware layer to put it in, so it lives here instead. Calls the
 * exact same resolveUserFromToken/assertCompleteProfile functions those
 * two use (see middleware/auth.ts) rather than its own copy of the
 * check — previously this reimplemented both rules independently, which
 * meant a future change to either REST gate had no guarantee of ever
 * reaching this one.
 */
function authenticateSocket(socket: Socket, next: (err?: Error) => void) {
  ;(async () => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') return next(new Error('unauthorized'))
    try {
      const user = await resolveUserFromToken(token)
      assertCompleteProfile(user)
      socket.data.userId = user.id
      next()
    } catch (err) {
      if (err instanceof ProfileIncompleteError) return next(new Error('profile incomplete'))
      next(new Error('unauthorized'))
    }
  })()
}

/**
 * The /comments namespace, authenticated (unlike the default namespace
 * below) — posting a comment needs a real user identity to attribute and
 * rate-limit, which round progress/settlement never needed. A namespace,
 * not a second server, so this shares the same port/instance with zero
 * extra infrastructure; it just carries its own connection middleware.
 */
function initCommentsNamespace(server: Server) {
  const comments = server.of('/comments')
  comments.use(authenticateSocket)

  comments.on('connection', (socket: Socket) => {
    // Own-userId room, same pattern as /wallet below — lets a reply
    // notification reach exactly the one person it's for (comment:replied)
    // without touching the public comment:new broadcast everyone else gets.
    socket.join(socket.data.userId)

    socket.on('comment:send', async (payload: unknown, ack?: PostAck) => {
      try {
        const body = typeof payload === 'string' ? payload : (payload as { body?: unknown })?.body
        const replyToId = typeof payload === 'object' && payload ? (payload as { replyToId?: unknown }).replyToId : undefined
        const comment = await createComment(
          socket.data.userId,
          typeof body === 'string' ? body : '',
          typeof replyToId === 'string' ? replyToId : undefined,
        )
        comments.emit('comment:new', comment)

        // Notify whoever's being replied to — never yourself (replying to
        // your own comment is a normal, unremarkable thing to do, not
        // something that should ping you). Both channels fire the same
        // way every other notification in this app does: a private
        // socket event for "currently in the app" (sw.ts will show-then-
        // close the matching push if so, trusting this instead) and a
        // real push either way for "currently outside it."
        if (comment.replyTo && comment.replyTo.user.id !== socket.data.userId) {
          const recipientId = comment.replyTo.user.id
          comments.to(recipientId).emit('comment:replied', comment)
          sendPushToUserIds([recipientId], {
            title: `${comment.user.displayName} replied to your comment`,
            body: comment.body,
            url: '/',
          }).catch((err) => console.error('comment-reply push failed:', err))
        }

        ack?.({ ok: true })
      } catch (err) {
        const code =
          err instanceof CommentRateLimitError
            ? 'RATE_LIMIT'
            : err instanceof CommentValidationError
              ? 'VALIDATION_ERROR'
              : err instanceof CommentReplyNotFoundError
                ? 'REPLY_NOT_FOUND'
                : 'ERROR'
        const message =
          err instanceof CommentReplyNotFoundError
            ? 'That comment is no longer available to reply to'
            : err instanceof Error
              ? err.message
              : 'Failed to post comment'
        ack?.({ ok: false, code, message })
      }
    })
  })
}

/**
 * The /wallet namespace — authenticated like /comments, but no shared
 * broadcast: each socket joins a room keyed by its own userId, so a
 * balance change can be pushed to exactly the one account it belongs to
 * rather than every connected client. See notifyWalletUpdate below for
 * the emit side.
 */
function initWalletNamespace(server: Server) {
  const wallet = server.of('/wallet')
  wallet.use(authenticateSocket)

  wallet.on('connection', (socket: Socket) => {
    socket.join(socket.data.userId)
  })
}

// Stops retrying after a handful of attempts with a short capped backoff,
// instead of ioredis's default of retrying forever — found the hard way
// while testing this locally: REDIS_URL was already set in .env to a
// leftover placeholder (redis://localhost:6379) from back when Redis
// wasn't needed yet, pointing at nothing real, and the default behavior
// spammed ECONNREFUSED indefinitely rather than ever giving up. The same
// stale value could just as easily be sitting in Render's real env vars
// right now — this makes "set but unreachable" fail fast and quiet
// instead of becoming a permanent background error storm in production
// logs.
function boundedRetry(times: number): number | null {
  return times > 3 ? null : Math.min(times * 200, 1000)
}

/**
 * Wires in the Redis adapter so broadcasts (round:progress, wallet:updated,
 * comment:new, etc.) fan out correctly across *multiple* server instances,
 * not just within whichever one instance happened to handle a given
 * connection — without this, a client connected to a different instance
 * than the one that processed an event would simply never hear about it.
 *
 * Only takes effect once BOTH connections are actually confirmed ready,
 * not just because REDIS_URL happens to be set (see boundedRetry's
 * comment on why that distinction matters) — io.adapter() is deliberately
 * not called until then, so an unset or unreachable REDIS_URL leaves
 * Socket.IO on its default in-memory adapter the whole time, same as
 * before this existed. That's the correct, fully-functional single-
 * instance behavior, not a degraded fallback.
 */
function attachRedisAdapter(io: Server) {
  const url = process.env.REDIS_URL
  if (!url) {
    console.log('REDIS_URL not set — Socket.IO running in-memory, single-instance only')
    return
  }

  const pubClient = new Redis(url, { retryStrategy: boundedRetry })
  const subClient = pubClient.duplicate()

  let pubReady = false
  let subReady = false
  function attachOnceBothReady() {
    if (!pubReady || !subReady) return
    io.adapter(createAdapter(pubClient, subClient))
    console.log('Socket.IO using the Redis adapter — broadcasts now fan out across instances')
  }

  pubClient.on('ready', () => {
    pubReady = true
    attachOnceBothReady()
  })
  subClient.on('ready', () => {
    subReady = true
    attachOnceBothReady()
  })
  pubClient.on('error', (err) => console.error('Redis (pub) error:', err.message || String(err)))
  subClient.on('error', (err) => console.error('Redis (sub) error:', err.message || String(err)))
  // Fires once boundedRetry gives up — the "set but unreachable" case.
  pubClient.on('end', () => {
    if (!pubReady) console.error('Redis (pub) gave up reconnecting — staying on the in-memory adapter')
  })
}

/**
 * No handshake auth on the default namespace: round progress/settlement
 * outcomes aren't per-user-sensitive (everyone already sees who won), so
 * that channel is intentionally public. /comments and /wallet are the
 * two places that do need per-user identity.
 */
export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
      credentials: true,
    },
  })
  attachRedisAdapter(io)
  initCommentsNamespace(io)
  initWalletNamespace(io)
  return io
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO not initialized — initSocket() must run before getIo()')
  return io
}

/**
 * Broadcasting is a best-effort side effect, not a correctness
 * requirement — draw entries must still work correctly when nothing has
 * called initSocket() (integration tests and dev scripts call
 * draw.service.placeEntry directly, with no HTTP server running at all).
 * Callers that only want to emit if a socket server happens to exist
 * should use this instead of getIo().
 */
export function tryGetIo(): Server | null {
  return io
}

/**
 * Pushes a fresh balance to exactly one user's /wallet room — call this
 * after any transaction that moves money has already committed (never
 * from inside one that could still roll back, same rule round:settled
 * follows). Covers every wallet-affecting flow that exists today (a
 * draw entry's debit, a payout's credit) and is the hook a future
 * Paystack webhook handler should call into as soon as it lands, so a
 * deposit shows up the instant it's confirmed instead of waiting for
 * the viewer to happen to revisit the Wallet page.
 */
export function notifyWalletUpdate(userId: string, balanceMinor: bigint) {
  tryGetIo()
    ?.of('/wallet')
    .to(userId)
    .emit('wallet:updated', { balanceMinor: balanceMinor.toString() })
}

/**
 * Tells every connected viewer exactly which comments just aged out (see
 * jobs/commentExpiry.ts), so an open tab drops those rows immediately
 * instead of waiting for its own 24h client-side filter or a reload.
 */
export function notifyCommentsExpired(ids: string[]) {
  tryGetIo()?.of('/comments').emit('comment:expired', { ids })
}

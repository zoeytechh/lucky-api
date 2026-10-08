import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { verifyAccessToken } from '../lib/jwt'
import { prisma } from '../lib/prisma'
import {
  CommentRateLimitError,
  CommentValidationError,
  createComment,
} from '../services/comment.service'

let io: Server | null = null

type PostAck = (res: { ok: true } | { ok: false; code: string; message: string }) => void

/**
 * Shared by every authenticated namespace (/comments, /wallet) — same
 * JWT handshake + mandatory-avatar-and-name gate as requireCompleteProfile
 * on the REST side, just with no Express middleware layer to put it in,
 * so it lives here instead. Centralized so the two namespaces can't
 * drift into two slightly different versions of "who's allowed to
 * connect."
 */
function authenticateSocket(socket: Socket, next: (err?: Error) => void) {
  ;(async () => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') return next(new Error('unauthorized'))
    try {
      const payload = verifyAccessToken(token)
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true, avatarUrl: true, fullName: true },
      })
      if (!user) return next(new Error('unauthorized'))
      if (user.role === 'USER' && (!user.avatarUrl || !user.fullName)) {
        return next(new Error('profile incomplete'))
      }
      socket.data.userId = payload.sub
      next()
    } catch {
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
    socket.on('comment:send', async (body: unknown, ack?: PostAck) => {
      try {
        const comment = await createComment(socket.data.userId, typeof body === 'string' ? body : '')
        comments.emit('comment:new', comment)
        ack?.({ ok: true })
      } catch (err) {
        const code =
          err instanceof CommentRateLimitError
            ? 'RATE_LIMIT'
            : err instanceof CommentValidationError
              ? 'VALIDATION_ERROR'
              : 'ERROR'
        const message = err instanceof Error ? err.message : 'Failed to post comment'
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

/**
 * Plain in-memory Socket.IO — no Redis adapter. The adapter from the
 * original M10 plan is only needed to fan out events across *multiple*
 * server instances; Render is running a single instance of lucky-api, so
 * in-memory broadcast reaches every connected client correctly on its
 * own. Revisit only if this backend ever scales horizontally.
 *
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

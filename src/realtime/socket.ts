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
 * The /comments namespace, authenticated (unlike the default namespace
 * below) — posting a comment needs a real user identity to attribute and
 * rate-limit, which round progress/settlement never needed. A namespace,
 * not a second server, so this shares the same port/instance with zero
 * extra infrastructure; it just carries its own connection middleware.
 */
function initCommentsNamespace(server: Server) {
  const comments = server.of('/comments')

  comments.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') return next(new Error('unauthorized'))
    try {
      const payload = verifyAccessToken(token)
      // Same mandatory-avatar gate as every other authenticated route
      // (requireCompleteProfile) — enforced here too since the comment
      // feed has no separate middleware layer to put it in. SYSTEM/ADMIN
      // stay exempt, same reasoning as the REST gate.
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true, avatarUrl: true },
      })
      if (!user) return next(new Error('unauthorized'))
      if (user.role === 'USER' && !user.avatarUrl) {
        return next(new Error('profile incomplete'))
      }
      socket.data.userId = payload.sub
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

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
 * Plain in-memory Socket.IO — no Redis adapter. The adapter from the
 * original M10 plan is only needed to fan out events across *multiple*
 * server instances; Render is running a single instance of lucky-api, so
 * in-memory broadcast reaches every connected client correctly on its
 * own. Revisit only if this backend ever scales horizontally.
 *
 * No handshake auth on the default namespace: round progress/settlement
 * outcomes aren't per-user-sensitive (everyone already sees who won), so
 * that channel is intentionally public. The /comments namespace above is
 * the one place that does need per-user identity.
 */
export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
      credentials: true,
    },
  })
  initCommentsNamespace(io)
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

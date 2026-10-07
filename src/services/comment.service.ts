import { displayNameFor } from '../lib/displayName'
import { prisma } from '../lib/prisma'

export const MAX_COMMENT_LENGTH = 280
export const MAX_RECENT_COMMENTS = 100

export class CommentValidationError extends Error {}
export class CommentRateLimitError extends Error {}

// A per-user cooldown between posts — the social-feed equivalent of the
// draw's own idempotency keys, just much simpler: this isn't money, so an
// in-memory Map is enough (same reasoning as realtime/socket.ts's "no
// Redis adapter" — Render runs a single instance; this resets on restart,
// which is fine for a lightweight anti-spam guard). Revisit only if this
// backend ever scales horizontally.
const RATE_LIMIT_MS = 8_000
const lastPostedAt = new Map<string, number>()

export type CommentWithUser = {
  id: string
  body: string
  createdAt: Date
  user: { id: string; displayName: string }
}

function toCommentWithUser(c: {
  id: string
  body: string
  createdAt: Date
  user: { id: string; fullName: string | null; phoneNumber: string }
}): CommentWithUser {
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    user: { id: c.user.id, displayName: displayNameFor(c.user) },
  }
}

export async function createComment(userId: string, rawBody: string): Promise<CommentWithUser> {
  const body = rawBody.trim()
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new CommentValidationError(`Comment must be 1–${MAX_COMMENT_LENGTH} characters`)
  }

  const last = lastPostedAt.get(userId) ?? 0
  const waitMs = RATE_LIMIT_MS - (Date.now() - last)
  if (waitMs > 0) {
    throw new CommentRateLimitError(`Please wait ${Math.ceil(waitMs / 1000)}s before commenting again`)
  }

  const comment = await prisma.drawComment.create({
    data: { userId, body },
    include: { user: { select: { id: true, fullName: true, phoneNumber: true } } },
  })
  lastPostedAt.set(userId, Date.now())

  return toCommentWithUser(comment)
}

export async function listRecentComments(limit = MAX_RECENT_COMMENTS): Promise<CommentWithUser[]> {
  const take = Math.min(Math.max(limit, 1), MAX_RECENT_COMMENTS)
  const comments = await prisma.drawComment.findMany({
    where: { isHidden: false },
    orderBy: { createdAt: 'desc' },
    take,
    include: { user: { select: { id: true, fullName: true, phoneNumber: true } } },
  })
  return comments.map(toCommentWithUser)
}

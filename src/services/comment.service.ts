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

export const COMMENT_TTL_MS = 24 * 60 * 60 * 1000

// Comments are a lightweight social layer, not part of the money ledger —
// each one is deliberately not kept past 24h from when it was posted.
// Called periodically by the scheduled expiry job (see
// jobs/commentExpiry.ts), not from any HTTP route. Returns the ids
// actually deleted, so the caller can tell connected clients exactly
// which rows to drop rather than re-syncing the whole feed.
export async function expireOldComments(): Promise<string[]> {
  const cutoff = new Date(Date.now() - COMMENT_TTL_MS)
  const expired = await prisma.drawComment.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
  })
  if (expired.length === 0) return []
  const ids = expired.map((c) => c.id)
  await prisma.drawComment.deleteMany({ where: { id: { in: ids } } })
  return ids
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

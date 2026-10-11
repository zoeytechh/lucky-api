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
  replyTo: { id: string; body: string; user: { id: string; displayName: string } } | null
}

type RawComment = {
  id: string
  body: string
  createdAt: Date
  user: { id: string; fullName: string | null; phoneNumber: string }
  replyTo: {
    id: string
    body: string
    user: { id: string; fullName: string | null; phoneNumber: string }
  } | null
}

function toCommentWithUser(c: RawComment): CommentWithUser {
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    user: { id: c.user.id, displayName: displayNameFor(c.user) },
    replyTo: c.replyTo
      ? {
          id: c.replyTo.id,
          body: c.replyTo.body,
          user: { id: c.replyTo.user.id, displayName: displayNameFor(c.replyTo.user) },
        }
      : null,
  }
}

const COMMENT_INCLUDE = {
  user: { select: { id: true, fullName: true, phoneNumber: true } },
  replyTo: { include: { user: { select: { id: true, fullName: true, phoneNumber: true } } } },
} as const

export class CommentReplyNotFoundError extends Error {}

export async function createComment(
  userId: string,
  rawBody: string,
  replyToId?: string,
): Promise<CommentWithUser> {
  const body = rawBody.trim()
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new CommentValidationError(`Comment must be 1–${MAX_COMMENT_LENGTH} characters`)
  }

  const last = lastPostedAt.get(userId) ?? 0
  const waitMs = RATE_LIMIT_MS - (Date.now() - last)
  if (waitMs > 0) {
    throw new CommentRateLimitError(`Please wait ${Math.ceil(waitMs / 1000)}s before commenting again`)
  }

  if (replyToId) {
    // Must exist and still be visible — replying to a hidden/already-
    // vanished comment would notify someone about a comment they can no
    // longer even see, which is more confusing than just rejecting it.
    const target = await prisma.drawComment.findUnique({ where: { id: replyToId } })
    if (!target || target.isHidden) throw new CommentReplyNotFoundError()
  }

  const comment = await prisma.drawComment.create({
    data: { userId, body, replyToId },
    include: COMMENT_INCLUDE,
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
//
// A thread's lifetime is governed by its root, not each reply's own age
// — only top-level comments (replyToId null) are checked against the
// cutoff directly. Deleting an expired root cascades (schema's
// onDelete: Cascade) to every reply beneath it, transitively, however
// recently any of them were posted — a reply can never outlive the root
// it's attached to. (A reply's createdAt is always >= its root's, so the
// root is always the first thing in its own thread to reach the cutoff;
// this can't leave a stale-but-young reply behind the other way around.)
export async function expireOldComments(): Promise<string[]> {
  const cutoff = new Date(Date.now() - COMMENT_TTL_MS)
  const expiredRoots = await prisma.drawComment.findMany({
    where: { replyToId: null, createdAt: { lt: cutoff } },
    select: { id: true },
  })
  if (expiredRoots.length === 0) return []
  const rootIds = expiredRoots.map((c) => c.id)

  // The delete itself only needs the root ids (Cascade handles the
  // rest), but connected clients need the *complete* list of what's
  // about to disappear — otherwise a reply would linger in an
  // already-loaded feed with its thread root gone. Resolved before the
  // delete, while the rows (and the FK relationships the CTE walks) are
  // still there to query.
  const affected = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE thread AS (
      SELECT id FROM draw_comments WHERE id = ANY(${rootIds})
      UNION ALL
      SELECT dc.id FROM draw_comments dc JOIN thread t ON dc.reply_to_id = t.id
    )
    SELECT id FROM thread
  `
  const allIds = affected.map((r) => r.id)

  await prisma.drawComment.deleteMany({ where: { id: { in: rootIds } } })
  return allIds
}

export async function listRecentComments(limit = MAX_RECENT_COMMENTS): Promise<CommentWithUser[]> {
  const take = Math.min(Math.max(limit, 1), MAX_RECENT_COMMENTS)
  const comments = await prisma.drawComment.findMany({
    where: { isHidden: false },
    orderBy: { createdAt: 'desc' },
    take,
    include: COMMENT_INCLUDE,
  })
  return comments.map(toCommentWithUser)
}

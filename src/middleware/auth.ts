import type { NextFunction, Request, Response } from 'express'
import { verifyAccessToken } from '../lib/jwt'
import { prisma } from '../lib/prisma'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

export type AuthedUser = { id: string; role: string; avatarUrl: string | null; fullName: string | null }

// Thrown by resolveUserFromToken when the token doesn't resolve to a
// real, current user — distinguished from a plain JWT-verify failure
// (bad signature, expired) only so requireAuth below can keep its two
// slightly different messages; callers that don't care can just treat
// any throw here as "not authenticated."
export class UnauthenticatedError extends Error {}

/**
 * The one place "is this token valid, and who does it belong to" is
 * decided. requireAuth (Express, below) and authenticateSocket
 * (Socket.IO, see realtime/socket.ts) both call this instead of each
 * re-implementing the JWT-verify + user-lookup pair — before this, the
 * two had quietly drifted into two separate copies of the same check,
 * with no guarantee a future change to one would ever reach the other.
 * Re-fetches from the DB on every call rather than trusting the token's
 * own claims, so a revoked/deleted user's still-valid-looking token
 * stops working immediately, not just after it expires.
 */
export async function resolveUserFromToken(token: string): Promise<AuthedUser> {
  const payload = verifyAccessToken(token) // throws on invalid/expired — left uncaught, same as before
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, avatarUrl: true, fullName: true },
  })
  if (!user) throw new UnauthenticatedError()
  return user
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authenticated' })
  }

  try {
    req.user = await resolveUserFromToken(header.slice('Bearer '.length))
    next()
  } catch (err) {
    if (err instanceof UnauthenticatedError) return res.status(401).json({ message: 'Not authenticated' })
    return res.status(401).json({ message: 'Invalid or expired session' })
  }
}

// Gates the admin wallet/payout routes — role==='ADMIN' only, no self-
// service way to become one (see admin.routes.ts's own comment). Checked
// after requireAuth, same as requireCompleteProfile, so req.user is
// already populated.
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' })
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Admin access required', code: 'ADMIN_REQUIRED' })
  }
  next()
}

export class ProfileIncompleteError extends Error {}

/**
 * The one place "does this profile count as complete" is decided — same
 * reasoning as resolveUserFromToken above: requireCompleteProfile
 * (Express) and authenticateSocket (Socket.IO) both call this instead of
 * each re-implementing the rule. A real display name is as mandatory as
 * the avatar — both exist for the same reason (see the PRD's
 * accountability rationale): a winner reveal or a public feed showing a
 * masked phone number instead of a name reads as anonymous/
 * untrustworthy for a real-money product.
 */
export function assertCompleteProfile(user: AuthedUser): void {
  if (user.role !== 'USER') return // SYSTEM/ADMIN exempt
  if (!user.avatarUrl || !user.fullName) throw new ProfileIncompleteError()
}

export function requireCompleteProfile(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' })

  try {
    assertCompleteProfile(req.user)
    next()
  } catch {
    return res.status(403).json({
      message: 'Profile incomplete — add a profile photo and your name to continue',
      code: 'PROFILE_INCOMPLETE',
    })
  }
}

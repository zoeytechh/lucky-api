import type { NextFunction, Request, Response } from 'express'
import { verifyAccessToken } from '../lib/jwt'
import { prisma } from '../lib/prisma'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: string; avatarUrl: string | null; fullName: string | null }
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authenticated' })
  }

  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length))
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, avatarUrl: true, fullName: true },
    })
    if (!user) return res.status(401).json({ message: 'Not authenticated' })

    req.user = user
    next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired session' })
  }
}

// A real display name is as mandatory as the avatar — both exist for the
// same reason (see the PRD's accountability rationale): a winner reveal
// or a public feed showing a masked phone number instead of a name reads
// as anonymous/untrustworthy for a real-money product. Checked alongside
// avatarUrl here, not as a separate gate, so the two can never drift out
// of sync about what "complete" means.
export function requireCompleteProfile(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' })

  if (req.user.role !== 'USER') return next() // SYSTEM/ADMIN exempt

  if (!req.user.avatarUrl || !req.user.fullName) {
    return res.status(403).json({
      message: 'Profile incomplete — add a profile photo and your name to continue',
      code: 'PROFILE_INCOMPLETE',
    })
  }

  next()
}

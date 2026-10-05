import type { NextFunction, Request, Response } from 'express'
import { verifyAccessToken } from '../lib/jwt'
import { prisma } from '../lib/prisma'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: string; avatarUrl: string | null }
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
      select: { id: true, role: true, avatarUrl: true },
    })
    if (!user) return res.status(401).json({ message: 'Not authenticated' })

    req.user = user
    next()
  } catch {
    return res.status(401).json({ message: 'Invalid or expired session' })
  }
}

export function requireCompleteProfile(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' })

  if (req.user.role !== 'USER') return next() // SYSTEM/ADMIN exempt

  if (!req.user.avatarUrl) {
    return res.status(403).json({
      message: 'Profile incomplete — upload a profile photo to continue',
      code: 'PROFILE_INCOMPLETE',
    })
  }

  next()
}

import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth'
import { uploadAvatar } from '../lib/cloudinary'
import { prisma } from '../lib/prisma'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WEBP images are allowed'))
    }
    cb(null, true)
  },
})

// multer's own middleware reports a bad file (wrong type, over the 5MB
// limit) by calling next(err) — left alone, that skips straight past
// this route to the app's generic error handler in index.ts, which
// exists specifically to hide an unexpected exception's own message
// from the client. A bad photo isn't that: fileFilter and the size
// limit already produce a perfectly good, specific message (just via a
// callback instead of a throw), so it's intercepted here and turned
// into the same shaped 400 every other validation failure in this app
// returns, instead of a generic "Something went wrong."
function handleAvatarUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('avatar')(req, res, (err: unknown) => {
    if (!err) return next()
    const message =
      err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 5MB or smaller'
        : err instanceof Error
          ? err.message
          : 'Invalid image'
    res.status(400).json({ message, code: 'INVALID_FILE' })
  })
}

// Deliberately NOT behind requireCompleteProfile — this is how a user
// completes their profile in the first place.
router.post('/avatar', requireAuth, handleAvatarUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No image provided' })

  const avatarUrl = await uploadAvatar(req.file.buffer, req.user!.id)

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { avatarUrl },
    select: { id: true, phoneNumber: true, fullName: true, avatarUrl: true, role: true },
  })

  res.json({ user })
})

const updateSchema = z.object({ fullName: z.string().trim().min(1).max(80) })

router.patch('/', requireAuth, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Invalid name' })

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { fullName: parsed.data.fullName },
    select: { id: true, phoneNumber: true, fullName: true, avatarUrl: true, role: true },
  })

  res.json({ user })
})

export default router

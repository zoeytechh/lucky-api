import { Router } from 'express'
import multer from 'multer'
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

// Deliberately NOT behind requireCompleteProfile — this is how a user
// completes their profile in the first place.
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No image provided' })

  const avatarUrl = await uploadAvatar(req.file.buffer, req.user!.id)

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { avatarUrl },
    select: { id: true, phoneNumber: true, fullName: true, avatarUrl: true, role: true },
  })

  res.json({ user })
})

export default router

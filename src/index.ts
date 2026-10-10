import { createServer } from 'node:http'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import { scheduleCommentExpiry } from './jobs/commentExpiry'
import { prisma } from './lib/prisma'
import { initSocket } from './realtime/socket'
import authRoutes from './routes/auth.routes'
import commentsRoutes from './routes/comments.routes'
import drawRoutes from './routes/draw.routes'
import profileRoutes from './routes/profile.routes'
import pushRoutes from './routes/push.routes'
import walletRoutes from './routes/wallet.routes'

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
    credentials: true,
  }),
)
app.use(express.json())
app.use(cookieParser())

// Deliberately checks the database, not just that the server process is
// up — a shallow check ("server responds") stays green even when the one
// dependency that matters (the database) is unreachable, which is exactly
// the failure mode that leaves an outage undetected. This is what an
// uptime monitor should actually be pointed at.
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() })
  } catch (err) {
    console.error('Health check: database unreachable:', err)
    res.status(503).json({
      status: 'error',
      database: 'disconnected',
      timestamp: new Date().toISOString(),
    })
  }
})

app.use('/api/auth', authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/draw', drawRoutes)
app.use('/api/wallet', walletRoutes)
app.use('/api/comments', commentsRoutes)
app.use('/api/push', pushRoutes)

// Route modules are added here as each build-order step lands:
// webhooks.routes, leaderboard.routes (see the plan).

// Every *expected* failure (insufficient balance, bad OTP, validation,
// etc.) is already caught and given its own friendly message + code at
// the route itself — this middleware only ever sees genuinely
// unexpected crashes. Logged in full server-side (so it's still
// debuggable), but never echoed to the client: an internal exception's
// own message is an implementation detail — occasionally a literal
// JS/Node error string like "Do not know how to serialize a BigInt",
// seen live — not something a user should read, and not guaranteed
// safe to expose (could as easily carry a query fragment or a file
// path). A generic message + code is what the client actually needs:
// something ErrorAlert can show instead of a raw dump.
// biome-ignore lint: express identifies error middleware by arity (4 args)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err)
  res.status(500).json({ message: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' })
})

// A plain http.Server wrapping Express, not app.listen() directly —
// Socket.IO needs to attach to the raw server to share the same port.
const server = createServer(app)
initSocket(server)
scheduleCommentExpiry()

const port = Number(process.env.PORT ?? 4000)
server.listen(port, () => {
  console.log(`lucky-api listening on :${port}`)
})

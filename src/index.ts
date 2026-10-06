import cookieParser from 'cookie-parser'
import cors from 'cors'
import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import { prisma } from './lib/prisma'
import authRoutes from './routes/auth.routes'
import drawRoutes from './routes/draw.routes'
import profileRoutes from './routes/profile.routes'
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

// Route modules are added here as each build-order step lands:
// webhooks.routes, leaderboard.routes, comments.routes (see the plan).

// biome-ignore lint: express identifies error middleware by arity (4 args)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err)
  const message = err instanceof Error ? err.message : 'Internal server error'
  res.status(500).json({ message })
})

const port = Number(process.env.PORT ?? 4000)
app.listen(port, () => {
  console.log(`lucky-api listening on :${port}`)
})

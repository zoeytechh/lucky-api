import cookieParser from 'cookie-parser'
import cors from 'cors'
import 'dotenv/config'
import express, { type NextFunction, type Request, type Response } from 'express'
import authRoutes from './routes/auth.routes'
import profileRoutes from './routes/profile.routes'

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
    credentials: true,
  }),
)
app.use(express.json())
app.use(cookieParser())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/auth', authRoutes)
app.use('/api/profile', profileRoutes)

// Route modules are added here as each build-order step lands:
// draw.routes, wallet.routes, webhooks.routes, leaderboard.routes,
// comments.routes (see the implementation plan).

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

import cors from 'cors'
import 'dotenv/config'
import express from 'express'

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
    credentials: true,
  }),
)
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Route modules are added here as each build-order step lands:
// auth.routes, profile.routes, draw.routes, wallet.routes, webhooks.routes,
// leaderboard.routes, comments.routes (see the implementation plan).

const port = Number(process.env.PORT ?? 4000)
app.listen(port, () => {
  console.log(`lucky-api listening on :${port}`)
})

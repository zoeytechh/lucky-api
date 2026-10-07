import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'

let io: Server | null = null

/**
 * Plain in-memory Socket.IO — no Redis adapter. The adapter from the
 * original M10 plan is only needed to fan out events across *multiple*
 * server instances; Render is running a single instance of lucky-api, so
 * in-memory broadcast reaches every connected client correctly on its
 * own. Revisit only if this backend ever scales horizontally.
 *
 * No handshake auth: round progress/settlement outcomes aren't
 * per-user-sensitive (everyone already sees the leaderboard, everyone
 * will see who won), so this channel is intentionally public. Auth
 * becomes relevant if a future per-user channel (e.g. the comment feed,
 * also M10) is added to this same server.
 */
export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173',
      credentials: true,
    },
  })
  return io
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO not initialized — initSocket() must run before getIo()')
  return io
}

/**
 * Broadcasting is a best-effort side effect, not a correctness
 * requirement — draw entries must still work correctly when nothing has
 * called initSocket() (integration tests and dev scripts call
 * draw.service.placeEntry directly, with no HTTP server running at all).
 * Callers that only want to emit if a socket server happens to exist
 * should use this instead of getIo().
 */
export function tryGetIo(): Server | null {
  return io
}

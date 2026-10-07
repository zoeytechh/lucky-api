import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { signAccessToken } from '../../src/lib/jwt'
import { prisma } from '../../src/lib/prisma'
import { initSocket } from '../../src/realtime/socket'
import { cleanupTestUsers } from '../helpers'

/**
 * Real socket.io-client against a real socket.io server attached to a
 * real http.Server — same pattern as draw-socket.test.ts, applied to the
 * /comments namespace's own concerns: handshake auth (valid JWT + a
 * complete profile, both required), the per-user post rate limit, and
 * that a post actually broadcasts to every connected client, not just
 * gets acked to the sender.
 */
describe('comments realtime namespace', () => {
  let server: HttpServer
  let port: number

  beforeAll(async () => {
    server = createServer()
    initSocket(server)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  let trackedUserIds: string[] = []
  let clients: ClientSocket[] = []

  afterEach(async () => {
    for (const c of clients) c.disconnect()
    clients = []
    await cleanupTestUsers(trackedUserIds)
    trackedUserIds = []
  })

  // Default-parameter destructuring, not `??` — `??` treats an explicit
  // `avatarUrl: null` the same as "not provided" and silently falls back
  // to the default, which is exactly wrong for the incomplete-profile
  // test case below (it needs a real null to reach the DB).
  async function createUser({ avatarUrl = 'https://example.com/a.png' }: { avatarUrl?: string | null } = {}) {
    const user = await prisma.user.create({
      data: { phoneNumber: `+1TEST${randomUUID()}`, avatarUrl },
    })
    trackedUserIds.push(user.id)
    return user
  }

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(`http://localhost:${port}/comments`, {
        transports: ['websocket'],
        auth: { token },
      })
      clients.push(socket)
      socket.on('connect', () => resolve(socket))
      socket.on('connect_error', (err) => reject(err))
    })
  }

  it('rejects a connection with no token and with an incomplete profile', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const socket = ioClient(`http://localhost:${port}/comments`, { transports: ['websocket'] })
        clients.push(socket)
        socket.on('connect', () => resolve('connected'))
        socket.on('connect_error', (err) => reject(err))
      }),
    ).rejects.toBeTruthy()

    const incompleteUser = await createUser({ avatarUrl: null })
    const token = signAccessToken({ sub: incompleteUser.id, role: 'USER' })
    await expect(connect(token)).rejects.toBeTruthy()
  })

  it('posts a comment, broadcasts it to every connected client, and persists it', async () => {
    const author = await createUser()
    const viewer = await createUser()

    const authorSocket = await connect(signAccessToken({ sub: author.id, role: 'USER' }))
    const viewerSocket = await connect(signAccessToken({ sub: viewer.id, role: 'USER' }))

    const viewerReceived = new Promise((resolve) => {
      viewerSocket.on('comment:new', resolve)
    })

    const body = `hello from the test suite ${randomUUID()}`
    const ack = await new Promise<{ ok: boolean }>((resolve) => {
      authorSocket.emit('comment:send', body, resolve)
    })
    expect(ack.ok).toBe(true)

    const received = (await viewerReceived) as { id: string; body: string; user: { id: string } }
    expect(received.body).toBe(body)
    expect(received.user.id).toBe(author.id)

    const stored = await prisma.drawComment.findUnique({ where: { id: received.id } })
    expect(stored?.body).toBe(body)

    await prisma.drawComment.delete({ where: { id: received.id } })
  })

  it('rejects an empty or over-length comment without persisting it', async () => {
    const author = await createUser()
    const socket = await connect(signAccessToken({ sub: author.id, role: 'USER' }))

    const emptyAck = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      socket.emit('comment:send', '   ', resolve)
    })
    expect(emptyAck.ok).toBe(false)
    expect(emptyAck.code).toBe('VALIDATION_ERROR')

    const tooLongAck = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      socket.emit('comment:send', 'x'.repeat(281), resolve)
    })
    expect(tooLongAck.ok).toBe(false)
    expect(tooLongAck.code).toBe('VALIDATION_ERROR')

    const count = await prisma.drawComment.count({ where: { userId: author.id } })
    expect(count).toBe(0)
  })

  it('rate-limits a second post from the same user within the cooldown window', async () => {
    const author = await createUser()
    const socket = await connect(signAccessToken({ sub: author.id, role: 'USER' }))

    const first = await new Promise<{ ok: boolean }>((resolve) => {
      socket.emit('comment:send', `first ${randomUUID()}`, resolve)
    })
    expect(first.ok).toBe(true)

    const second = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      socket.emit('comment:send', `second ${randomUUID()}`, resolve)
    })
    expect(second.ok).toBe(false)
    expect(second.code).toBe('RATE_LIMIT')

    await prisma.drawComment.deleteMany({ where: { userId: author.id } })
  })
})

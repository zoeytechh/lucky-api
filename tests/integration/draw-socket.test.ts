import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ENTRY_COST_MINOR, ROUND_SIZE } from '../../src/config/constants'
import { prisma } from '../../src/lib/prisma'
import { initSocket } from '../../src/realtime/socket'
import { placeEntry } from '../../src/services/draw.service'
import { cleanupEmptyRounds, cleanupTestUsers, createFundedTestUsers } from '../helpers'

/**
 * Verifies the actual wire behavior added for the live draw reveal
 * (draw.service.placeEntry emitting via realtime/socket.ts) — a real
 * socket.io-client connected to a real socket.io server attached to a
 * real http.Server, not a mock of either side. The other integration
 * test files call placeEntry directly with no socket server running at
 * all (see tryGetIo's doc comment) — this file is the one place that
 * actually boots one, specifically to exercise the broadcast.
 */
describe('draw round realtime broadcast', () => {
  let server: HttpServer
  let port: number
  let client: ClientSocket | undefined

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

  afterEach(async () => {
    client?.disconnect()
    client = undefined
    await cleanupTestUsers(trackedUserIds)
    await cleanupEmptyRounds()
    trackedUserIds = []
  })

  async function drainCurrentOpenRound(): Promise<string[]> {
    const open = await prisma.drawRound.findFirst({ where: { status: 'OPEN' } })
    const remaining = open ? ROUND_SIZE - open.entryCount : ROUND_SIZE
    if (remaining <= 0) return []
    const users = await createFundedTestUsers(remaining, ENTRY_COST_MINOR * 2n)
    await Promise.all(users.map((u) => placeEntry(u.id, `test-drain:${randomUUID()}`)))
    return users.map((u) => u.id)
  }

  it('broadcasts round:progress on every entry and round:settled exactly once when the round fills', async () => {
    const draining = await drainCurrentOpenRound()
    trackedUserIds.push(...draining)

    client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] })
    await new Promise<void>((resolve, reject) => {
      client!.on('connect', resolve)
      client!.on('connect_error', reject)
    })

    // biome-ignore lint: test-local accumulators, shape intentionally loose
    const progressEvents: any[] = []
    // biome-ignore lint: test-local accumulators, shape intentionally loose
    const settledEvents: any[] = []
    client.on('round:progress', (payload) => progressEvents.push(payload))
    client.on('round:settled', (payload) => settledEvents.push(payload))

    const users = await createFundedTestUsers(ROUND_SIZE, ENTRY_COST_MINOR * 2n)
    trackedUserIds.push(...users.map((u) => u.id))

    const results = await Promise.all(
      users.map((u) => placeEntry(u.id, `test-socket:${randomUUID()}`)),
    )
    const winningResult = results.find((r) => r.roundSettled)!

    // Events arrive asynchronously over the socket after placeEntry's
    // promises already resolved — give the client a moment to receive
    // them before asserting.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    expect(progressEvents).toHaveLength(ROUND_SIZE)
    expect(progressEvents.every((e) => e.roundId === winningResult.roundId)).toBe(true)
    expect(progressEvents.map((e) => e.entryCount).sort((a, b) => a - b)).toEqual(
      Array.from({ length: ROUND_SIZE }, (_, i) => i + 1),
    )
    expect(progressEvents.every((e) => e.capacity === ROUND_SIZE)).toBe(true)

    expect(settledEvents).toHaveLength(1) // exactly one broadcast, from the one request that settled it
    expect(settledEvents[0].roundId).toBe(winningResult.roundId)
    expect(settledEvents[0].roundNumber).toBe(winningResult.roundNumber)
    expect(settledEvents[0].winnerSlotNumber).toBeGreaterThanOrEqual(1)
    expect(settledEvents[0].winnerSlotNumber).toBeLessThanOrEqual(ROUND_SIZE)
    expect(settledEvents[0].nextRoundId).toBeTruthy()
    expect(settledEvents[0].nextRoundNumber).toBe(winningResult.roundNumber + 1)
  })

  it('a replayed idempotency key does not re-broadcast round:progress', async () => {
    const draining = await drainCurrentOpenRound()
    trackedUserIds.push(...draining)

    client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] })
    await new Promise<void>((resolve, reject) => {
      client!.on('connect', resolve)
      client!.on('connect_error', reject)
    })

    // biome-ignore lint: test-local accumulator, shape intentionally loose
    const progressEvents: any[] = []
    client.on('round:progress', (payload) => progressEvents.push(payload))

    const users = await createFundedTestUsers(1, ENTRY_COST_MINOR * 2n)
    trackedUserIds.push(...users.map((u) => u.id))
    const key = `test-replay:${randomUUID()}`

    await placeEntry(users[0].id, key)
    await placeEntry(users[0].id, key) // replay — same key, nothing new happened

    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(progressEvents).toHaveLength(1) // not 2 — the replay is a no-op, so it must not re-broadcast
  })
})

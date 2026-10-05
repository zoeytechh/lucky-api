import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma, runInTransaction } from '../../src/lib/prisma'
import { credit, debit, getOrCreateWallet } from '../../src/services/wallet.service'
import { cleanupTestUser, createTestUser } from '../helpers'

describe('wallet concurrency correctness', () => {
  let userId: string

  beforeEach(async () => {
    const user = await createTestUser()
    userId = user.id
  })

  afterEach(async () => {
    await cleanupTestUser(userId)
  })

  it('50 concurrent credits to the same wallet: no lost updates', async () => {
    const CONCURRENCY = 50
    const AMOUNT = 1_000n

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        runInTransaction((tx) =>
          credit(tx, {
            userId,
            amountMinor: AMOUNT,
            entryType: 'DEPOSIT',
            idempotencyKey: `test:${randomUUID()}`,
          }),
        ),
      ),
    )

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(AMOUNT * BigInt(CONCURRENCY))

    const entries = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } })
    expect(entries).toHaveLength(CONCURRENCY)
    const sum = entries.reduce((acc, e) => acc + e.amountMinor, 0n)
    expect(wallet.balanceMinor).toBe(sum) // the core invariant, under real concurrency
  })

  it('concurrent debits racing for limited funds: exactly as many succeed as the balance allows, never more', async () => {
    const STARTING_CREDITS = 10
    const AMOUNT = 1_000n
    const ATTEMPTS = 30 // 3x the funds available — most of these must fail

    await runInTransaction((tx) =>
      credit(tx, {
        userId,
        amountMinor: AMOUNT * BigInt(STARTING_CREDITS),
        entryType: 'DEPOSIT',
        idempotencyKey: `test:${randomUUID()}`,
      }),
    )

    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () =>
        runInTransaction((tx) =>
          debit(tx, {
            userId,
            amountMinor: AMOUNT,
            entryType: 'DRAW_ENTRY_STAKE',
            idempotencyKey: `test:${randomUUID()}`,
          }),
        ),
      ),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')

    // This is the assertion that actually proves the row lock works: if
    // debits weren't serialized per-wallet, overlapping check-then-act
    // sequences could let more than STARTING_CREDITS succeed (an overdraft)
    // — exactly the bug class row locking exists to prevent.
    expect(succeeded).toHaveLength(STARTING_CREDITS)
    expect(failed).toHaveLength(ATTEMPTS - STARTING_CREDITS)

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(0n) // every successful debit spent, none overdrawn, none lost

    const entries = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } })
    expect(entries).toHaveLength(1 + STARTING_CREDITS) // the deposit + the successful debits
    const sum = entries.reduce((acc, e) => acc + e.amountMinor, 0n)
    expect(wallet.balanceMinor).toBe(sum)
  })

  it('idempotency key replay under concurrency: only one of N simultaneous identical requests applies', async () => {
    const key = `test:${randomUUID()}`
    const CONCURRENCY = 10

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        runInTransaction((tx) =>
          credit(tx, { userId, amountMinor: 5_000n, entryType: 'DEPOSIT', idempotencyKey: key }),
        ),
      ),
    )

    const appliedCount = results.filter((r) => r.applied).length
    expect(appliedCount).toBe(1) // a double-tap / retried request must only ever apply once

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(5_000n)
  })
})

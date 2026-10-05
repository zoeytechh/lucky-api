import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma, runInTransaction } from '../../src/lib/prisma'
import { InsufficientFundsError } from '../../src/services/ledger.service'
import { credit, debit, getOrCreateWallet } from '../../src/services/wallet.service'
import { cleanupTestUser, createTestUser } from '../helpers'

describe('wallet debit/credit', () => {
  let userId: string

  beforeEach(async () => {
    const user = await createTestUser()
    userId = user.id
  })

  afterEach(async () => {
    await cleanupTestUser(userId)
  })

  it('credit increases balance and records a ledger entry with the correct balanceAfter', async () => {
    const result = await runInTransaction((tx) =>
      credit(tx, {
        userId,
        amountMinor: 100_000n,
        entryType: 'DEPOSIT',
        idempotencyKey: `test:${randomUUID()}`,
      }),
    )

    expect(result.balanceMinor).toBe(100_000n)
    expect(result.ledgerEntry.amountMinor).toBe(100_000n)
    expect(result.ledgerEntry.balanceAfterMinor).toBe(100_000n)

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(100_000n)
  })

  it('debit decreases balance correctly', async () => {
    await runInTransaction((tx) =>
      credit(tx, {
        userId,
        amountMinor: 200_000n,
        entryType: 'DEPOSIT',
        idempotencyKey: `test:${randomUUID()}`,
      }),
    )

    const result = await runInTransaction((tx) =>
      debit(tx, {
        userId,
        amountMinor: 75_000n,
        entryType: 'DRAW_ENTRY_STAKE',
        idempotencyKey: `test:${randomUUID()}`,
      }),
    )

    expect(result.balanceMinor).toBe(125_000n)
    expect(result.ledgerEntry.amountMinor).toBe(-75_000n)
  })

  it('debit beyond balance throws InsufficientFundsError and changes nothing', async () => {
    await runInTransaction((tx) =>
      credit(tx, {
        userId,
        amountMinor: 50_000n,
        entryType: 'DEPOSIT',
        idempotencyKey: `test:${randomUUID()}`,
      }),
    )

    await expect(
      runInTransaction((tx) =>
        debit(tx, {
          userId,
          amountMinor: 100_000n,
          entryType: 'DRAW_ENTRY_STAKE',
          idempotencyKey: `test:${randomUUID()}`,
        }),
      ),
    ).rejects.toThrow(InsufficientFundsError)

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(50_000n)
    expect(await prisma.ledgerEntry.count({ where: { walletId: wallet.id } })).toBe(1) // only the deposit
  })

  it('replaying the same idempotencyKey is a no-op, not a double-application', async () => {
    const key = `test:${randomUUID()}`

    const first = await runInTransaction((tx) =>
      credit(tx, { userId, amountMinor: 100_000n, entryType: 'DEPOSIT', idempotencyKey: key }),
    )
    const second = await runInTransaction((tx) =>
      credit(tx, { userId, amountMinor: 100_000n, entryType: 'DEPOSIT', idempotencyKey: key }),
    )

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.ledgerEntry.id).toBe(first.ledgerEntry.id)

    const wallet = await getOrCreateWallet(prisma, userId)
    expect(wallet.balanceMinor).toBe(100_000n) // not 200,000
    expect(await prisma.ledgerEntry.count({ where: { walletId: wallet.id } })).toBe(1)
  })

  it('balance always equals the sum of its ledger entries', async () => {
    await runInTransaction((tx) =>
      credit(tx, { userId, amountMinor: 300_000n, entryType: 'DEPOSIT', idempotencyKey: `test:${randomUUID()}` }),
    )
    await runInTransaction((tx) =>
      debit(tx, { userId, amountMinor: 120_000n, entryType: 'DRAW_ENTRY_STAKE', idempotencyKey: `test:${randomUUID()}` }),
    )
    await runInTransaction((tx) =>
      credit(tx, { userId, amountMinor: 50_000n, entryType: 'DRAW_REFUND', idempotencyKey: `test:${randomUUID()}` }),
    )

    const wallet = await getOrCreateWallet(prisma, userId)
    const entries = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } })
    const sum = entries.reduce((acc, e) => acc + e.amountMinor, 0n)

    expect(wallet.balanceMinor).toBe(sum)
    expect(wallet.balanceMinor).toBe(230_000n)
  })
})

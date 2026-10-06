import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma'
import type { Prisma } from '../generated/prisma/client'
import type { LedgerEntryType } from '../generated/prisma/enums'
import { postLedgerEntry } from './ledger.service'

const SYSTEM_PHONE = '+0000000000' // sentinel — never a real Nigerian number

type WalletFullRow = {
  id: string
  user_id: string
  balance_minor: bigint
  currency: string
  created_at: Date
  updated_at: Date
}

function mapWalletRow(row: WalletFullRow) {
  return {
    id: row.id,
    userId: row.user_id,
    balanceMinor: row.balance_minor,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Two concurrent callers for a brand-new user can both see "no wallet" and
 * both race to create one. A plain try/create-catch-fallback doesn't work
 * here: inside a Postgres transaction, one failed statement (the loser's
 * unique-constraint violation) aborts the *entire* transaction — no
 * further queries are allowed until rollback, so a fallback lookup in the
 * same catch block fails too (confirmed by the test suite: "current
 * transaction is aborted"). `upsert()` was tried first and expected to
 * compile to an atomic INSERT ... ON CONFLICT DO UPDATE, but under real
 * concurrency it still surfaced a raw unique-violation — not reliable as
 * Prisma 7 compiles it through the pg driver adapter inside an existing
 * interactive transaction.
 *
 * The fix that's actually safe inside a transaction: raw
 * `INSERT ... ON CONFLICT DO NOTHING`, which never raises an exception on
 * conflict (0 rows returned, transaction stays healthy) — then a plain
 * SELECT only if nothing was inserted.
 */
export async function getOrCreateWallet(tx: Prisma.TransactionClient, userId: string) {
  // SELECT first: the wallet almost always already exists, so this keeps
  // the common case to one round trip instead of always attempting an
  // INSERT that's expected to conflict.
  const existing = await tx.$queryRaw<WalletFullRow[]>`
    SELECT id, user_id, balance_minor, currency, created_at, updated_at
    FROM wallets WHERE user_id = ${userId}
  `
  if (existing.length > 0) return mapWalletRow(existing[0])

  const id = randomUUID()
  const inserted = await tx.$queryRaw<WalletFullRow[]>`
    INSERT INTO wallets (id, user_id, balance_minor, currency, created_at, updated_at)
    VALUES (${id}, ${userId}, 0, 'NGN', now(), now())
    ON CONFLICT (user_id) DO NOTHING
    RETURNING id, user_id, balance_minor, currency, created_at, updated_at
  `
  if (inserted.length > 0) return mapWalletRow(inserted[0])

  // Lost the race — another transaction created it between our SELECT
  // and INSERT attempt above.
  const fallback = await tx.$queryRaw<WalletFullRow[]>`
    SELECT id, user_id, balance_minor, currency, created_at, updated_at
    FROM wallets WHERE user_id = ${userId}
  `
  if (fallback.length === 0) throw new Error(`Failed to get or create wallet for user ${userId}`)
  return mapWalletRow(fallback[0])
}

type UserRow = { id: string }

// The SYSTEM user's id never changes once created — memoized in-process
// so a hot path that touches it on every single draw entry (crediting the
// fee) costs zero round trips after the first one this process ever makes,
// instead of one SELECT every time.
let cachedSystemUserId: string | null = null

/**
 * The company revenue account's user id (fees are credited here via the
 * normal credit() path, keyed by userId like any other wallet movement —
 * see draw.service.ts). Same ON CONFLICT DO NOTHING pattern as
 * getOrCreateWallet above, for the same reason.
 */
export async function getSystemUserId(tx: Prisma.TransactionClient = prisma) {
  if (cachedSystemUserId) return cachedSystemUserId

  // SELECT first — see getOrCreateWallet's comment; the SYSTEM user exists
  // after the very first call ever, so this is a one-trip lookup on every
  // subsequent draw entry instead of a wasted INSERT attempt each time.
  const existing = await tx.$queryRaw<UserRow[]>`
    SELECT id FROM users WHERE phone_number = ${SYSTEM_PHONE}
  `
  if (existing[0]) {
    cachedSystemUserId = existing[0].id
    return cachedSystemUserId
  }

  const id = randomUUID()
  const inserted = await tx.$queryRaw<UserRow[]>`
    INSERT INTO users (id, phone_number, role, full_name, created_at, updated_at)
    VALUES (${id}, ${SYSTEM_PHONE}, 'SYSTEM', 'Lucky (system)', now(), now())
    ON CONFLICT (phone_number) DO NOTHING
    RETURNING id
  `
  if (inserted[0]) {
    cachedSystemUserId = inserted[0].id
    return cachedSystemUserId
  }

  const fallback = await tx.$queryRaw<UserRow[]>`
    SELECT id FROM users WHERE phone_number = ${SYSTEM_PHONE}
  `
  if (!fallback[0]) throw new Error('Failed to get or create SYSTEM user')
  cachedSystemUserId = fallback[0].id
  return cachedSystemUserId
}

/** The company revenue wallet: fees land here, leaderboard prizes are paid from it. */
export async function getSystemWallet(tx: Prisma.TransactionClient = prisma) {
  return getOrCreateWallet(tx, await getSystemUserId(tx))
}

type WalletRow = { id: string; balance_minor: bigint }

/**
 * Locks the wallet row for the duration of the enclosing transaction
 * (Postgres SELECT ... FOR UPDATE) — concurrent callers touching the same
 * wallet queue up and run strictly one at a time. This is the mechanism
 * that makes debit/credit race-free; everything below trusts it.
 *
 * Looks up and locks by userId directly (one round trip) rather than
 * calling getOrCreateWallet first and then locking by the returned id
 * (two round trips) — the wallet almost always already exists by the
 * time money moves through it, so this collapses the common case from 2
 * queries to 1. Only falls back to getOrCreateWallet (create-or-find,
 * its own race-safe logic) when the wallet genuinely doesn't exist yet.
 */
async function lockWalletByUserId(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<WalletRow[]>`
    SELECT id, balance_minor FROM wallets WHERE user_id = ${userId} FOR UPDATE
  `
  if (rows.length > 0) return rows[0]

  const created = await getOrCreateWallet(tx, userId)
  const locked = await tx.$queryRaw<WalletRow[]>`
    SELECT id, balance_minor FROM wallets WHERE id = ${created.id} FOR UPDATE
  `
  return locked[0]
}

type MovementParams = {
  userId: string
  amountMinor: bigint // always positive here — sign is applied by debit/credit
  entryType: LedgerEntryType
  referenceType?: string
  referenceId?: string
  idempotencyKey: string
  metadata?: Record<string, unknown>
}

async function applyMovement(
  tx: Prisma.TransactionClient,
  signedAmountMinor: bigint,
  params: MovementParams,
) {
  const locked = await lockWalletByUserId(tx, params.userId)

  const { ledgerEntry, newBalanceMinor, applied } = await postLedgerEntry(
    tx,
    locked.balance_minor,
    {
      walletId: locked.id,
      amountMinor: signedAmountMinor,
      entryType: params.entryType,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata,
    },
  )

  if (applied) {
    await tx.wallet.update({
      where: { id: locked.id },
      data: { balanceMinor: newBalanceMinor },
    })
  }

  return { walletId: locked.id, balanceMinor: newBalanceMinor, ledgerEntry, applied }
}

/** Debits a wallet. Throws InsufficientFundsError if it would go negative. */
export function debit(tx: Prisma.TransactionClient, params: MovementParams) {
  return applyMovement(tx, -params.amountMinor, params)
}

/** Credits a wallet. */
export function credit(tx: Prisma.TransactionClient, params: MovementParams) {
  return applyMovement(tx, params.amountMinor, params)
}

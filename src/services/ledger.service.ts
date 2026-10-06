import { randomUUID } from 'node:crypto'
import type { Prisma } from '../generated/prisma/client'
import type { LedgerEntryType } from '../generated/prisma/enums'

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds')
  }
}

type PostParams = {
  walletId: string
  amountMinor: bigint // signed: positive = credit, negative = debit
  entryType: LedgerEntryType
  referenceType?: string
  referenceId?: string
  idempotencyKey: string
  metadata?: Record<string, unknown>
}

type LedgerRow = {
  id: string
  wallet_id: string
  amount_minor: bigint
  entry_type: LedgerEntryType
  reference_type: string | null
  reference_id: string | null
  balance_after_minor: bigint
  idempotency_key: string
  metadata: unknown
  created_at: Date
}

function mapLedgerRow(row: LedgerRow) {
  return {
    id: row.id,
    walletId: row.wallet_id,
    amountMinor: row.amount_minor,
    entryType: row.entry_type,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    balanceAfterMinor: row.balance_after_minor,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata,
    createdAt: row.created_at,
  }
}

/**
 * Inserts one ledger entry and updates the wallet's cached balance in the
 * same transaction. The caller MUST already hold a row lock on the wallet
 * (see wallet.service) — this function trusts the balance it's given and
 * does not lock anything itself, so it's only safe to call from inside
 * that locked context.
 *
 * Idempotent via a single `INSERT ... ON CONFLICT (idempotency_key) DO
 * NOTHING` (one round trip for the common/non-replay case) rather than a
 * separate existence check before the insert (two round trips) — cut from
 * the entry/settlement path specifically because it's on the hot,
 * lock-serialized path where every round trip compounds (see the plan's
 * M5 section and progress.md for the latency finding that motivated this).
 * On conflict (0 rows returned), falls back to one SELECT to return the
 * original entry untouched (applied: false) instead of double-posting.
 */
export async function postLedgerEntry(
  tx: Prisma.TransactionClient,
  currentBalanceMinor: bigint,
  params: PostParams,
) {
  const newBalanceMinor = currentBalanceMinor + params.amountMinor
  if (newBalanceMinor < 0n) {
    throw new InsufficientFundsError()
  }

  const id = randomUUID()
  const inserted = await tx.$queryRaw<LedgerRow[]>`
    INSERT INTO ledger_entries
      (id, wallet_id, amount_minor, entry_type, reference_type, reference_id, balance_after_minor, idempotency_key, metadata, created_at)
    VALUES (
      ${id},
      ${params.walletId},
      ${params.amountMinor.toString()}::bigint,
      ${params.entryType},
      ${params.referenceType ?? null},
      ${params.referenceId ?? null},
      ${newBalanceMinor.toString()}::bigint,
      ${params.idempotencyKey},
      ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb,
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id, wallet_id, amount_minor, entry_type, reference_type, reference_id, balance_after_minor, idempotency_key, metadata, created_at
  `

  if (inserted.length > 0) {
    return { ledgerEntry: mapLedgerRow(inserted[0]), newBalanceMinor, applied: true as const }
  }

  const existing = await tx.$queryRaw<LedgerRow[]>`
    SELECT id, wallet_id, amount_minor, entry_type, reference_type, reference_id, balance_after_minor, idempotency_key, metadata, created_at
    FROM ledger_entries WHERE idempotency_key = ${params.idempotencyKey}
  `
  if (!existing[0]) throw new Error(`Ledger entry conflict but not found for key ${params.idempotencyKey}`)
  return {
    ledgerEntry: mapLedgerRow(existing[0]),
    newBalanceMinor: currentBalanceMinor,
    applied: false as const,
  }
}

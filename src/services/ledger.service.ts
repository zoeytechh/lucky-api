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

/**
 * Inserts one ledger entry and updates the wallet's cached balance in the
 * same transaction. The caller MUST already hold a row lock on the wallet
 * (see wallet.service.lockWallet) — this function trusts the balance it's
 * given and does not lock anything itself, so it's only safe to call from
 * inside that locked context.
 *
 * Idempotent: a repeat call with the same idempotencyKey returns the
 * original entry untouched (applied: false) instead of double-posting —
 * this is the core replay-safety mechanism for every money-moving flow.
 */
export async function postLedgerEntry(
  tx: Prisma.TransactionClient,
  currentBalanceMinor: bigint,
  params: PostParams,
) {
  const existing = await tx.ledgerEntry.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  })
  if (existing) {
    return { ledgerEntry: existing, newBalanceMinor: currentBalanceMinor, applied: false as const }
  }

  const newBalanceMinor = currentBalanceMinor + params.amountMinor
  if (newBalanceMinor < 0n) {
    throw new InsufficientFundsError()
  }

  const ledgerEntry = await tx.ledgerEntry.create({
    data: {
      walletId: params.walletId,
      amountMinor: params.amountMinor,
      entryType: params.entryType,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      balanceAfterMinor: newBalanceMinor,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  })

  return { ledgerEntry, newBalanceMinor, applied: true as const }
}

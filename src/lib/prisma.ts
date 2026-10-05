import { PrismaPg } from '@prisma/adapter-pg'
import type { Prisma } from '../generated/prisma/client'
import { PrismaClient } from '../generated/prisma/client'

// node-postgres defaults a pool to max 10 connections — too few for any
// real burst of concurrent requests (confirmed by the test suite: 50
// concurrent wallet operations queued for a connection and blew past even
// a 15s maxWait). Sized here with the same forward-looking M5 concern as
// runInTransaction below: the real production case this has to hold up
// under is up to ~1000 entries hitting the same draw round around its
// 1000th slot, not just this test's 50.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 50 })

export const prisma = new PrismaClient({ adapter })

/**
 * Prisma's interactive-transaction default (maxWait ~2s to acquire a slot,
 * timeout 5s to complete) is too tight for anything that contends on a row
 * lock — a transaction queued behind another holding FOR UPDATE can exceed
 * that budget before it's ever had a turn, which isn't a correctness bug
 * in the locking, just too small a clock for real contention. Every
 * money-moving transaction (wallet debit/credit now; the draw entry lock
 * in M5) should go through this helper rather than raw prisma.$transaction
 * so that budget is consistent everywhere, not re-decided per call site.
 *
 * Forward-looking note for M5: this generous a timeout works for wallet-
 * level contention (one user's concurrent requests, not hundreds). The
 * planned 1000-way serialization on a single draw round's row lock is a
 * fundamentally bigger queue than this timeout is sized for — if entries
 * near the end of a 1000-deep queue would still exceed even this budget,
 * that's a real signal the "hold FOR UPDATE for the whole queue" design
 * needs revisiting there (e.g. a lighter critical section, or external
 * queue-based serialization instead of DB lock queuing), not just a
 * bigger number here.
 */
export function runInTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(fn, { maxWait: 60_000, timeout: 60_000 })
}

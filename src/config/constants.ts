// All money in kobo (bigint), never float, to avoid rounding bugs.
export const STAKE_MINOR = 100_000n // ₦1,000
export const FEE_MINOR = 20_000n // ₦200
export const ENTRY_COST_MINOR = STAKE_MINOR + FEE_MINOR // ₦1,200

// Overridable via env for tests only — production always runs the real
// 1000. Settlement derives its refund/loss split from the actual number
// of entries found (see settlement.service.ts), not from a hardcoded
// 500/499, specifically so this can be tested at a small, fast scale
// using the exact same code path and formula as production, rather than
// a separate test-only partition calculation.
export const ROUND_SIZE = Number(process.env.DRAW_ROUND_SIZE) || 1000

// Half the stake pool, derived from ROUND_SIZE so it stays correct at
// whatever size is actually configured (real 1000: ₦500,000).
export const WINNER_PAYOUT_MINOR = (STAKE_MINOR * BigInt(ROUND_SIZE)) / 2n

// Reference only (the real N=1000 split) — settlement.service computes
// the actual split dynamically from entries.length, it does not import
// these.
export const REFUND_COUNT = Math.ceil((ROUND_SIZE - 1) / 2)
export const LOSS_COUNT = Math.floor((ROUND_SIZE - 1) / 2)

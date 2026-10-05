// All money in kobo (bigint), never float, to avoid rounding bugs.
export const STAKE_MINOR = 100_000n // ₦1,000
export const FEE_MINOR = 20_000n // ₦200
export const ENTRY_COST_MINOR = STAKE_MINOR + FEE_MINOR // ₦1,200
export const WINNER_PAYOUT_MINOR = 50_000_000n // ₦500,000

export const ROUND_SIZE = 1000
export const REFUND_COUNT = 500
export const LOSS_COUNT = 499

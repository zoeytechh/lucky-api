-- CreateEnum
CREATE TYPE "DrawRoundStatus" AS ENUM ('OPEN', 'SETTLED');

-- CreateEnum
CREATE TYPE "DrawEntryOutcome" AS ENUM ('PENDING', 'WON', 'REFUNDED', 'LOST');

-- CreateTable
CREATE TABLE "draw_rounds" (
    "id" TEXT NOT NULL,
    "round_number" SERIAL NOT NULL,
    "status" "DrawRoundStatus" NOT NULL DEFAULT 'OPEN',
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "winner_entry_id" TEXT,
    "refund_count" INTEGER,
    "loss_count" INTEGER,
    "shuffle_audit" JSONB,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "draw_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draw_entries" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slot_number" INTEGER NOT NULL,
    "stake_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "outcome" "DrawEntryOutcome" NOT NULL DEFAULT 'PENDING',
    "payout_minor" BIGINT,
    "idempotency_key" TEXT NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "draw_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "draw_rounds_round_number_key" ON "draw_rounds"("round_number");

-- CreateIndex
CREATE UNIQUE INDEX "draw_entries_idempotency_key_key" ON "draw_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "draw_entries_outcome_settled_at_idx" ON "draw_entries"("outcome", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "draw_entries_round_id_slot_number_key" ON "draw_entries"("round_id", "slot_number");

-- AddForeignKey
ALTER TABLE "draw_entries" ADD CONSTRAINT "draw_entries_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "draw_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draw_entries" ADD CONSTRAINT "draw_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added constraints (not expressible in Prisma schema language):

-- At most one OPEN round can ever exist, enforced by Postgres itself, not
-- just application logic. A partial unique index on a constant expression
-- means any second row matching the WHERE clause collides on the same
-- index entry as the first.
CREATE UNIQUE INDEX "one_open_round" ON "draw_rounds" ((true)) WHERE "status" = 'OPEN';

-- A round can never hold more or fewer than a sane number of entries, and
-- a slot can never be assigned outside 1..1000 — hard guarantees
-- independent of whether the application code that writes these rows has
-- a bug.
ALTER TABLE "draw_rounds" ADD CONSTRAINT "entry_count_range" CHECK ("entry_count" >= 0 AND "entry_count" <= 1000);
ALTER TABLE "draw_entries" ADD CONSTRAINT "slot_number_range" CHECK ("slot_number" >= 1 AND "slot_number" <= 1000);

-- AlterTable
ALTER TABLE "draw_rounds" ADD COLUMN     "entries_open_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "reveal_at" TIMESTAMP(3);

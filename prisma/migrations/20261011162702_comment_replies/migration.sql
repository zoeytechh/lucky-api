-- AlterTable
ALTER TABLE "draw_comments" ADD COLUMN     "reply_to_id" TEXT;

-- AddForeignKey
ALTER TABLE "draw_comments" ADD CONSTRAINT "draw_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "draw_comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

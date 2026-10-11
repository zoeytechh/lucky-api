-- DropForeignKey
ALTER TABLE "draw_comments" DROP CONSTRAINT "draw_comments_reply_to_id_fkey";

-- AddForeignKey
ALTER TABLE "draw_comments" ADD CONSTRAINT "draw_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "draw_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

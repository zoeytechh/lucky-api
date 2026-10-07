-- CreateTable
CREATE TABLE "draw_comments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draw_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "draw_comments_is_hidden_created_at_idx" ON "draw_comments"("is_hidden", "created_at");

-- AddForeignKey
ALTER TABLE "draw_comments" ADD CONSTRAINT "draw_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

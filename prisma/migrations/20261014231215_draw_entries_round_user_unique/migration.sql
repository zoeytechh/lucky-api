-- CreateIndex
CREATE UNIQUE INDEX "draw_entries_round_id_user_id_key" ON "draw_entries"("round_id", "user_id");

-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('pending', 'processing', 'ready', 'failed');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN "stream_status" "StreamStatus",
ADD COLUMN "stream_claimed_at" TIMESTAMP(3),
ADD COLUMN "stream_playlists" JSONB;

-- CreateIndex
CREATE INDEX "assets_stream_status_idx" ON "assets"("stream_status");

-- Queue existing videos for HLS transcoding
UPDATE "assets" SET "stream_status" = 'pending' WHERE "visibility" = 'private' AND "mime" LIKE 'video/%';

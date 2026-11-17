-- "Let buyers download it" now applies to every product type except courses, and replaces ebooks' "read online only".
ALTER TABLE "products"
  ADD COLUMN "downloadable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false;

UPDATE "products" SET "downloadable" = NOT "read_online" WHERE "type" = 'ebook';

-- Courses were never downloadable, nor was audio/video uploaded for streaming only.
UPDATE "products" p SET "downloadable" = false
WHERE p."type" = 'course'
   OR (p."type" = 'media' AND EXISTS (
        SELECT 1 FROM "product_files" pf JOIN "assets" a ON a."id" = pf."asset_id"
        WHERE pf."product_id" = p."id" AND a."stream_status" IS NOT NULL));

ALTER TABLE "products" DROP COLUMN "read_online";

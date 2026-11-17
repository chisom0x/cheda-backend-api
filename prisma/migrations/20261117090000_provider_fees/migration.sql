-- What Bachs (sales) and Paystack (plans) charge Cheda, so profit is net of payment processing.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "provider_fee" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "provider_fee" INTEGER NOT NULL DEFAULT 0;


-- Backfill at the current rates: Bachs 2% card, 1.5% bank transfer (and anything older);
-- Paystack 1.5% + NGN 100, with the NGN 100 waived under NGN 2,500.
UPDATE "orders"
SET "provider_fee" = ROUND("total" * CASE WHEN "payment_method" = 'card' THEN 0.02 ELSE 0.015 END)
WHERE "status" IN ('paid', 'refunded') AND "total" > 0;

UPDATE "subscription_payments"
SET "provider_fee" = ROUND("amount" * 0.015) + CASE WHEN "amount" < 250000 THEN 0 ELSE 10000 END;

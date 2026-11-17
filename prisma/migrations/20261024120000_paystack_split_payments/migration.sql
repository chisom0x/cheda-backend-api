-- AlterTable
ALTER TABLE "sellers" ADD COLUMN "paystack_subaccount_code" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "payout_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sellers_paystack_subaccount_code_key" ON "sellers"("paystack_subaccount_code");

-- CreateIndex
CREATE INDEX "orders_seller_id_status_payout_id_idx" ON "orders"("seller_id", "status", "payout_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

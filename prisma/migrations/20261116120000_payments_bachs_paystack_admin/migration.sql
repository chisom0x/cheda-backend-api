-- Plans bill through Paystack subscriptions, product sales through Bachs checkout,
-- withdrawals are requested by sellers and paid by hand, and admins get a role.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "fee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "sellers" ADD COLUMN     "paystack_customer_id" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "email_token" TEXT,
ADD COLUMN     "paystack_code" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'NGN',
    "reference" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_reference_key" ON "subscription_payments"("reference");

-- CreateIndex
CREATE INDEX "subscription_payments_paid_at_idx" ON "subscription_payments"("paid_at");

-- CreateIndex
CREATE INDEX "subscription_payments_seller_id_paid_at_idx" ON "subscription_payments"("seller_id", "paid_at");

-- CreateIndex
CREATE INDEX "orders_status_paid_at_idx" ON "orders"("status", "paid_at");

-- CreateIndex
CREATE INDEX "payouts_status_requested_at_idx" ON "payouts"("status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "sellers_paystack_customer_id_key" ON "sellers"("paystack_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paystack_code_key" ON "subscriptions"("paystack_code");

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


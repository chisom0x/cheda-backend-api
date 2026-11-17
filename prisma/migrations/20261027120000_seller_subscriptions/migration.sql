-- Single products now cover audio as well as video
ALTER TYPE "ProductType" RENAME VALUE 'video' TO 'media';

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('pro', 'premium');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'non_renewing', 'attention', 'completed', 'cancelled');

-- AlterTable
ALTER TABLE "sellers" ADD COLUMN "paystack_customer_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "sellers_paystack_customer_id_key" ON "sellers"("paystack_customer_id");

-- CreateTable
CREATE TABLE "subscriptions" (
    "seller_id" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "paystack_code" TEXT NOT NULL,
    "email_token" TEXT NOT NULL,
    "current_period_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("seller_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paystack_code_key" ON "subscriptions"("paystack_code");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

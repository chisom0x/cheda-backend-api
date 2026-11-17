-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('monthly', 'quarterly', 'annually');

-- AlterTable: every existing subscription was billed quarterly
ALTER TABLE "subscriptions" ADD COLUMN "interval" "BillingInterval" NOT NULL DEFAULT 'quarterly';

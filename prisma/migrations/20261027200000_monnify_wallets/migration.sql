-- Payments move to Monnify: Cheda collects every sale and keeps each seller's balance itself,
-- so Paystack subaccounts, customers and subscription tokens are no longer needed.

-- DropIndex
DROP INDEX "sellers_paystack_subaccount_code_key";

-- DropIndex
DROP INDEX "sellers_paystack_customer_id_key";

-- DropIndex
DROP INDEX "subscriptions_paystack_code_key";

-- AlterTable
ALTER TABLE "sellers" DROP COLUMN "paystack_subaccount_code",
DROP COLUMN "paystack_customer_id";

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "paystack_code",
DROP COLUMN "email_token";

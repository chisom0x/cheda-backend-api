import type { Currency, PaymentMethod } from '../generated/prisma/client';

export const FEE_PERCENT = 0.04;
export const FEE_FIXED: Record<Currency, number> = { NGN: 5_000, USD: 5 };

/** Charged on each withdrawal to cover the bank transfer. */
export const WITHDRAWAL_FEE = 5_000;

/** Bachs's rate for collecting a sale, by how the buyer pays. */
const BACHS_RATE: Record<PaymentMethod, number> = {
  card: 0.02,
  transfer: 0.015,
  ussd: 0.015,
};

/** What Bachs charges Cheda to collect a sale. */
export function bachsFee(totalMinor: number, method: PaymentMethod) {
  return totalMinor > 0 ? Math.round(totalMinor * BACHS_RATE[method]) : 0;
}

/** Paystack: 1.5% + ₦100, with the ₦100 waived under ₦2,500. Used when Paystack doesn't report its fee. */
export function paystackFee(amountMinor: number) {
  if (amountMinor <= 0) return 0;
  return Math.round(amountMinor * 0.015) + (amountMinor < 250_000 ? 0 : 10_000);
}

export function calculateFee(totalMinor: number, currency: Currency) {
  if (totalMinor <= 0) return 0;
  return Math.min(
    Math.round(totalMinor * FEE_PERCENT) + FEE_FIXED[currency],
    totalMinor,
  );
}

export function formatMoney(minor: number, currency: Currency = 'NGN') {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);
}

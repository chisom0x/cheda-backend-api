import { bachsFee, paystackFee } from './money';

describe('payment provider fees', () => {
  it('Bachs charges 2% on cards and 1.5% on bank transfers', () => {
    expect(bachsFee(500000, 'card')).toBe(10000); // ₦5,000 card -> ₦100
    expect(bachsFee(500000, 'transfer')).toBe(7500); // ₦5,000 transfer -> ₦75
    expect(bachsFee(0, 'card')).toBe(0);
  });

  it('Paystack charges 1.5% + ₦100, waiving the ₦100 under ₦2,500', () => {
    expect(paystackFee(200000)).toBe(3000); // ₦2,000 -> ₦30
    expect(paystackFee(249999)).toBe(3750); // just under ₦2,500 -> no ₦100
    expect(paystackFee(250000)).toBe(13750); // ₦2,500 -> ₦37.50 + ₦100
    expect(paystackFee(750000)).toBe(21250); // ₦7,500 Premium monthly -> ₦212.50
  });
});

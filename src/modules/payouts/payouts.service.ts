import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatMoney, WITHDRAWAL_FEE } from '../../common/money';
import { toPayout } from '../../common/presenters';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A paid sale's `net` sits in the seller's wallet until a withdrawal claims it. */
export const inWallet = {
  status: 'paid',
  total: { gt: 0 },
  payoutId: null,
} as const satisfies Prisma.OrderWhereInput;

@Injectable()
export class PayoutsService {
  constructor(private readonly prisma: PrismaService) {}

  async balance(sellerId: string) {
    const [available, payouts] = await Promise.all([
      this.prisma.order.aggregate({
        where: { sellerId, ...inWallet },
        _sum: { net: true },
      }),
      this.prisma.payout.groupBy({
        by: ['status'],
        where: { sellerId, status: { in: ['processing', 'paid'] } },
        _sum: { amount: true, fee: true },
      }),
    ]);
    const sum = (status: 'processing' | 'paid') => {
      const g = payouts.find((p) => p.status === status);
      return { amount: g?._sum.amount ?? 0, fee: g?._sum.fee ?? 0 };
    };
    const processing = sum('processing');
    const paid = sum('paid');
    const availableNet = available._sum.net ?? 0;
    return {
      currency: 'NGN' as const,
      available: availableNet,
      /** Requested withdrawals Cheda hasn't paid yet */
      processing: processing.amount,
      /** Received in the seller's bank, after withdrawal fees */
      paidOut: paid.amount - paid.fee,
      lifetimeEarnings: availableNet + processing.amount + paid.amount,
      withdrawalFee: WITHDRAWAL_FEE,
    };
  }

  async list(sellerId: string) {
    const payouts = await this.prisma.payout.findMany({
      where: { sellerId },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    return payouts.map(toPayout);
  }

  /**
   * Requests a withdrawal of the whole available balance. Cheda pays it by hand; until then it is
   * `processing`, and a declined request returns its orders to the wallet.
   */
  async withdraw(sellerId: string) {
    const seller = await this.prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      select: {
        bankCode: true,
        bankName: true,
        accountNumber: true,
        accountName: true,
      },
    });
    const { bankCode, bankName, accountNumber, accountName } = seller;
    if (!bankCode || !bankName || !accountNumber || !accountName)
      throw new BadRequestException('Add a bank account to withdraw to.');

    const payout = await this.prisma.$transaction(async (tx) => {
      const orders = await tx.order.findMany({
        where: { sellerId, ...inWallet },
        select: { id: true, net: true },
      });
      const amount = orders.reduce((sum, o) => sum + o.net, 0);
      if (amount <= 0)
        throw new BadRequestException(
          "You don't have anything to withdraw yet.",
        );
      if (amount <= WITHDRAWAL_FEE)
        throw new BadRequestException(
          `Your balance needs to be more than the ${formatMoney(WITHDRAWAL_FEE)} withdrawal fee.`,
        );
      const payout = await tx.payout.create({
        data: {
          sellerId,
          amount,
          fee: WITHDRAWAL_FEE,
          status: 'processing',
          bankCode,
          bankName,
          accountNumber,
          accountName,
          reference: `WDR_${randomUUID().replace(/-/g, '')}`,
        },
      });
      // A concurrent withdrawal claiming the same orders leaves fewer to claim here
      const { count } = await tx.order.updateMany({
        where: { id: { in: orders.map((o) => o.id) }, payoutId: null },
        data: { payoutId: payout.id },
      });
      if (count !== orders.length)
        throw new ConflictException(
          'Another withdrawal is in progress. Refresh and try again.',
        );
      return payout;
    });
    return toPayout(payout);
  }
}

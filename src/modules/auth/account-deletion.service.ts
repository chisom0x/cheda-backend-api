import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.decorator';
import {
  MailService,
  escapeHtml,
  layout,
} from '../../integrations/mail.service';
import { PaystackService } from '../../integrations/paystack.service';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PayoutsService } from '../payouts/payouts.service';
import { streamPrefix } from '../uploads/transcode.service';
import { OtpService } from './otp.service';

type AssetRef = {
  id: string;
  key: string;
  visibility: 'public' | 'private';
  streamStatus: string | null;
};

/**
 * Deletes an account at its owner's request (web and mobile share this), as promised on the
 * /delete-account page:
 * - Profile, sessions, progress, coupons, store stats and bank details are deleted.
 * - Products nobody bought are deleted with their files; products buyers paid for are unpublished
 *   and kept so those buyers keep what they bought.
 * - Orders, payouts and plan payments are kept for tax and accounting. When any exist the user and
 *   store rows are anonymised (they can't be deleted without breaking those records); otherwise the
 *   user row is deleted outright.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly payouts: PayoutsService,
    private readonly paystack: PaystackService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
  ) {}

  async request(user: AuthUser) {
    await this.assertDeletable(user);
    await this.otp.send(user.email, 'account_deletion');
    return { sent: true };
  }

  async confirm(user: AuthUser, code: string) {
    await this.assertDeletable(user);
    await this.otp.consume(user.email, 'account_deletion', code);
    if (user.sellerId) await this.cancelPlan(user.sellerId);

    const removed = await this.prisma.$transaction(async (tx) => {
      const sellerId = user.sellerId;
      let removedAssets: AssetRef[] = [];
      let keepsRecords = false;

      if (sellerId) {
        const sold = new Set(
          (
            await tx.order.findMany({
              where: { sellerId },
              distinct: ['productId'],
              select: { productId: true },
            })
          ).map((o) => o.productId),
        );
        const [payouts, planPayments] = await Promise.all([
          tx.payout.count({ where: { sellerId } }),
          tx.subscriptionPayment.count({ where: { sellerId } }),
        ]);
        keepsRecords = sold.size > 0 || payouts > 0 || planPayments > 0;

        // Files a bought product still uses (attached files, lesson files by id, cover images by
        // URL, which contains the key) stay; everything else the user uploaded goes.
        const soldProducts = await tx.product.findMany({
          where: { id: { in: [...sold] } },
          select: {
            cover: true,
            files: { select: { assetId: true } },
            course: { select: { modules: true } },
          },
        });
        const attached = new Set(
          soldProducts.flatMap((p) => p.files.map((f) => f.assetId)),
        );
        const referenced = JSON.stringify(
          soldProducts.map((p) => [p.cover, p.course?.modules]),
        );
        removedAssets = (
          await tx.asset.findMany({
            where: { ownerId: user.id },
            select: {
              id: true,
              key: true,
              visibility: true,
              streamStatus: true,
            },
          })
        ).filter(
          (a) =>
            !attached.has(a.id) &&
            !referenced.includes(a.id) &&
            !referenced.includes(a.key),
        );

        await tx.product.updateMany({
          where: { sellerId, id: { in: [...sold] } },
          data: { status: 'draft' },
        });
        await tx.product.deleteMany({
          where: { sellerId, id: { notIn: [...sold] } },
        });
        await tx.asset.deleteMany({
          where: { id: { in: removedAssets.map((a) => a.id) } },
        });
        await tx.coupon.deleteMany({ where: { sellerId } });
        await tx.visit.deleteMany({ where: { sellerId } });
        await tx.subscription.deleteMany({ where: { sellerId } });
      } else {
        removedAssets = await tx.asset.findMany({
          where: { ownerId: user.id },
          select: { id: true, key: true, visibility: true, streamStatus: true },
        });
      }

      await tx.order.updateMany({
        where: { buyerUserId: user.id },
        data: { buyerUserId: null },
      });

      if (!keepsRecords) {
        // Cascades to the store, sessions, progress and remaining assets.
        await tx.user.delete({ where: { id: user.id } });
        return removedAssets;
      }

      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.progress.deleteMany({ where: { userId: user.id } });
      await tx.seller.update({
        where: { id: sellerId! },
        data: {
          username: `deleted_${sellerId}`,
          displayName: 'Deleted store',
          headline: '',
          bio: '',
          avatar: { kind: 'gradient', preset: 'lemon' },
          banner: { kind: 'gradient', preset: 'ink' },
          socials: {},
          verified: false,
          bankCode: null,
          bankName: null,
          accountNumber: null,
          accountName: null,
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          name: 'Deleted user',
          email: `deleted+${user.id}@deleted.invalid`,
          passwordHash: null,
          firebaseUid: null,
          avatarUrl: null,
          emailVerifiedAt: null,
        },
      });
      return removedAssets;
    });

    // Storage can't join the transaction: the account is already gone, so a failed object delete is logged, not thrown.
    await Promise.all(removed.map((a) => this.deleteObjects(a)));
    this.mail
      .send({
        to: { email: user.email, name: user.name },
        subject: 'Your Cheda account has been deleted',
        html: layout(
          'Your account has been deleted',
          `<p>Hi ${escapeHtml(user.name)}, as you asked, we've deleted your Cheda account and the data linked to it. Records of past orders and payouts are kept only as long as the law requires.</p><p>If you didn't ask for this, reply to this email straight away.</p>`,
        ),
      })
      .catch((e: Error) =>
        this.logger.error(
          `Deletion email to ${user.email} failed: ${e.message}`,
        ),
      );
    return { deleted: true };
  }

  private async assertDeletable(user: AuthUser) {
    if (user.isAdmin)
      throw new ForbiddenException(
        'Admin accounts can’t be deleted from here. Ask another admin to remove your access first.',
      );
    if (!user.sellerId) return;
    const balance = await this.payouts.balance(user.sellerId);
    if (balance.available > 0)
      throw new ConflictException(
        'You still have money in your Cheda wallet. Withdraw it before deleting your account.',
      );
    if (balance.processing > 0)
      throw new ConflictException(
        'You have a withdrawal being processed. You can delete your account once it has been paid.',
      );
  }

  /** Stops future plan charges; deletion stops here if Paystack can't confirm it. */
  private async cancelPlan(sellerId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { sellerId },
      select: { status: true, paystackCode: true, emailToken: true },
    });
    if (
      !sub?.paystackCode ||
      !sub.emailToken ||
      !['active', 'attention'].includes(sub.status)
    )
      return;
    try {
      await this.paystack.disableSubscription(sub.paystackCode, sub.emailToken);
    } catch (e) {
      this.logger.error(
        `Could not cancel ${sub.paystackCode} for deletion: ${(e as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'We couldn’t cancel your Pro plan just now, so your account wasn’t deleted. Please try again in a few minutes.',
      );
    }
  }

  private async deleteObjects(asset: AssetRef) {
    try {
      await this.storage.delete(asset.key, asset.visibility);
      if (asset.streamStatus)
        await this.storage.deletePrefix(streamPrefix(asset.id));
    } catch (e) {
      this.logger.error(
        `Could not delete stored file ${asset.key}: ${(e as Error).message}`,
      );
    }
  }
}

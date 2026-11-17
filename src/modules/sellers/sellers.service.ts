import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser, SellerUser } from '../../common/auth/auth.decorator';
import { parseImageSource, parseSocials } from '../../common/json-fields';
import { toSeller, toUser } from '../../common/presenters';
import { PaystackService } from '../../integrations/paystack.service';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BankDto,
  NotificationsDto,
  ResolveAccountDto,
  StorefrontDto,
} from './sellers.dto';
import { assertUsernameShape, newSellerData } from './username';

@Injectable()
export class SellersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly storage: StorageService,
  ) {}

  async assertUsernameFree(username: string, exceptSellerId?: string) {
    assertUsernameShape(username);
    const taken = await this.prisma.seller.findUnique({
      where: { username },
      select: { id: true },
    });
    if (taken && taken.id !== exceptSellerId)
      throw new ConflictException('That username is taken. Try another.');
    return username;
  }

  async usernameAvailability(username: string) {
    try {
      await this.assertUsernameFree(username);
      return { available: true, reason: null };
    } catch (e) {
      return { available: false, reason: (e as Error).message };
    }
  }

  async becomeSeller(user: AuthUser, username: string, displayName: string) {
    if (user.sellerId)
      throw new BadRequestException('You already have a store.');
    await this.assertUsernameFree(username);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { seller: { create: newSellerData(username, displayName) } },
      include: { seller: { select: { id: true } } },
    });
    return toUser(updated);
  }

  async me(user: SellerUser) {
    return toSeller(
      await this.prisma.seller.findUniqueOrThrow({
        where: { id: user.sellerId },
      }),
    );
  }

  async updateStorefront(user: SellerUser, dto: StorefrontDto) {
    const publicUrl = this.storage.publicUrl;
    const seller = await this.prisma.seller.update({
      where: { id: user.sellerId },
      data: {
        displayName: dto.displayName,
        headline: dto.headline,
        bio: dto.bio,
        location: dto.location,
        accentColor: dto.accentColor,
        avatar: dto.avatar && parseImageSource(dto.avatar, publicUrl),
        banner: dto.banner && parseImageSource(dto.banner, publicUrl),
        socials: dto.socials && parseSocials(dto.socials),
      },
    });
    return toSeller(seller);
  }

  async updateNotifications(user: SellerUser, dto: NotificationsDto) {
    const { newSale, payoutSent, weeklySummary, productUpdates } = dto;
    const seller = await this.prisma.seller.update({
      where: { id: user.sellerId },
      data: {
        notifications: { newSale, payoutSent, weeklySummary, productUpdates },
      },
    });
    return toSeller(seller);
  }

  async resolveAccount(dto: ResolveAccountDto) {
    const accountName = await this.paystack
      .resolveAccount(dto.accountNumber, dto.bankCode)
      .catch(() => {
        throw new BadRequestException(
          "We couldn't verify that account. Check the number and bank.",
        );
      });
    return { accountName };
  }

  banks() {
    return this.paystack.listBanks();
  }

  /** Verifies the account with Paystack; storing its name puts the store live. */
  async saveBank(user: SellerUser, dto: BankDto) {
    const { accountName } = await this.resolveAccount(dto);
    const bank = (await this.paystack.listBanks()).find(
      (b) => b.code === dto.bankCode,
    );
    const seller = await this.prisma.seller.update({
      where: { id: user.sellerId },
      data: {
        bankCode: dto.bankCode,
        bankName: bank?.name ?? dto.bankName,
        accountNumber: dto.accountNumber,
        accountName,
      },
    });
    return toSeller(seller);
  }

  async changeUsername(user: SellerUser, username: string) {
    await this.assertUsernameFree(username, user.sellerId);
    return toSeller(
      await this.prisma.seller.update({
        where: { id: user.sellerId },
        data: { username },
      }),
    );
  }
}

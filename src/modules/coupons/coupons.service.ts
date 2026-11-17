import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { toCoupon } from '../../common/presenters';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponInputDto } from './coupons.dto';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(sellerId: string) {
    const coupons = await this.prisma.coupon.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
    });
    return coupons.map(toCoupon);
  }

  async create(sellerId: string, dto: CouponInputDto) {
    const data = await this.validate(sellerId, dto);
    return toCoupon(
      await this.prisma.coupon.create({ data: { ...data, sellerId } }),
    );
  }

  async update(sellerId: string, id: string, dto: CouponInputDto) {
    await this.own(sellerId, id);
    const data = await this.validate(sellerId, dto, id);
    return toCoupon(await this.prisma.coupon.update({ where: { id }, data }));
  }

  async setActive(sellerId: string, id: string, active: boolean) {
    await this.own(sellerId, id);
    return toCoupon(
      await this.prisma.coupon.update({ where: { id }, data: { active } }),
    );
  }

  async remove(sellerId: string, id: string) {
    await this.own(sellerId, id);
    await this.prisma.coupon.delete({ where: { id } });
    return true;
  }

  private async validate(
    sellerId: string,
    dto: CouponInputDto,
    exceptId?: string,
  ) {
    if (dto.type === 'percent' && dto.value > 100)
      throw new BadRequestException('Percent off must be between 1 and 100.');
    const clash = await this.prisma.coupon.findUnique({
      where: { sellerId_code: { sellerId, code: dto.code } },
      select: { id: true },
    });
    if (clash && clash.id !== exceptId)
      throw new ConflictException(
        `You already have a code called ${dto.code}.`,
      );
    const productIds = [...new Set(dto.productIds ?? [])];
    if (
      productIds.length &&
      (await this.prisma.product.count({
        where: { id: { in: productIds }, sellerId },
      })) !== productIds.length
    ) {
      throw new BadRequestException('Choose products from your store.');
    }
    return {
      code: dto.code,
      type: dto.type,
      value: dto.value,
      productIds,
      maxRedemptions: dto.maxRedemptions,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      active: dto.active,
    };
  }

  private async own(sellerId: string, id: string) {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, sellerId },
      select: { id: true },
    });
    if (!coupon) throw new NotFoundException('Discount code not found.');
  }
}

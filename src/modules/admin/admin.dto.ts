import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  OrderStatus,
  PayoutStatus,
  ProductStatus,
  ProductType,
  SubscriptionStatus,
} from '../../generated/prisma/client';
import { Trim } from '../../common/transforms';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A range of days in Lagos time, both ends inclusive. Defaults to the last 30 days. */
export class RangeDto {
  @IsOptional()
  @Matches(DAY, { message: 'from must be a date (YYYY-MM-DD).' })
  from?: string;

  @IsOptional()
  @Matches(DAY, { message: 'to must be a date (YYYY-MM-DD).' })
  to?: string;
}

export class PageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class UsersQueryDto extends PageDto {
  @IsOptional()
  @IsIn(['all', 'seller', 'buyer'])
  kind: 'all' | 'seller' | 'buyer' = 'all';
}

export class ProductsQueryDto extends PageDto {
  @IsOptional()
  @IsIn(Object.values(ProductStatus))
  status?: ProductStatus;

  @IsOptional()
  @IsIn(Object.values(ProductType))
  type?: ProductType;
}

export class PurchasesQueryDto extends PageDto {
  @IsOptional()
  @IsIn(Object.values(OrderStatus))
  status?: OrderStatus;

  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;
}

export class SubscriptionPaymentsQueryDto extends PageDto {
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;
}

export class SubscriptionsQueryDto extends PageDto {
  @IsOptional()
  @IsIn(Object.values(SubscriptionStatus))
  status?: SubscriptionStatus;
}

export class WithdrawalsQueryDto extends PageDto {
  @IsOptional()
  @IsIn(Object.values(PayoutStatus))
  status?: PayoutStatus;
}

export class DeclineDto {
  @Trim()
  @IsString()
  @Length(3, 300, { message: 'Give a short reason the creator will see.' })
  reason: string;
}

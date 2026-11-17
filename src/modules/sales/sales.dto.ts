import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/client';
import { Trim } from '../../common/transforms';

export const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
export type DashboardRange = keyof typeof RANGE_DAYS;

export class StatsQueryDto {
  @IsIn(Object.keys(RANGE_DAYS))
  range: DashboardRange;
}

export class OrderFiltersDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn([...Object.values(OrderStatus), 'all'])
  status?: OrderStatus | 'all';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  productId?: string;

  @IsOptional()
  @IsIn([...Object.keys(RANGE_DAYS), 'all'])
  range?: DashboardRange | 'all';
}

export class SearchDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;
}

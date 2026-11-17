import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CouponType } from '../../generated/prisma/client';
import { Upper } from '../../common/transforms';

export class CouponInputDto {
  @Upper()
  @Matches(/^[A-Z0-9_-]{3,20}$/, {
    message: 'Codes use 3–20 letters, numbers, dashes or underscores.',
  })
  code: string;

  @IsIn(Object.values(CouponType))
  type: CouponType;

  @IsInt()
  @Min(1, { message: 'The discount must be more than zero.' })
  value: number;

  @ValidateIf((o: CouponInputDto) => o.productIds !== null)
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  productIds: string[] | null;

  @ValidateIf((o: CouponInputDto) => o.maxRedemptions !== null)
  @IsInt()
  @Min(1)
  maxRedemptions: number | null;

  @ValidateIf((o: CouponInputDto) => o.expiresAt !== null)
  @IsDateString()
  expiresAt: string | null;

  @IsBoolean()
  active: boolean;
}

export class CouponActiveDto {
  @IsBoolean()
  active: boolean;
}

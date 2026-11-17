import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { PaymentMethod } from '../../generated/prisma/client';
import { Trim, Lower, Upper } from '../../common/transforms';

export class QuoteDto {
  @IsString()
  @MaxLength(40)
  productId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000_00)
  amount?: number;

  @IsOptional()
  @Upper()
  @IsString()
  @MaxLength(20)
  couponCode?: string;
}

export class CheckoutDto extends QuoteDto {
  @Lower()
  @IsEmail(
    {},
    { message: 'Enter a valid email so we can send your access link.' },
  )
  @MaxLength(254)
  email: string;

  @Trim()
  @IsString()
  @Length(2, 80, { message: 'Enter your name.' })
  name: string;

  /** USSD isn't offered by Bachs; past orders may still carry it. */
  @IsIn(['card', 'transfer'], { message: 'Choose card or bank transfer.' })
  paymentMethod: Exclude<PaymentMethod, 'ussd'>;
}

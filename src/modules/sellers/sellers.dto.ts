import {
  IsBoolean,
  IsHexColor,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Trim, Lower } from '../../common/transforms';

export class UsernameQueryDto {
  @Lower()
  @IsString()
  @MaxLength(40)
  u: string;
}

export class UsernameDto {
  @Lower()
  @IsString()
  @MaxLength(40)
  username: string;
}

export class BecomeSellerDto extends UsernameDto {
  @Trim()
  @IsString()
  @Length(2, 60, { message: 'Your store needs a name.' })
  displayName: string;
}

export class StorefrontDto {
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60, { message: 'Your store needs a name.' })
  displayName?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  headline?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  location?: string;

  @IsOptional()
  @IsObject()
  avatar?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  banner?: Record<string, unknown>;

  @IsOptional()
  @IsHexColor()
  accentColor?: string;

  @IsOptional()
  @IsObject()
  socials?: Record<string, unknown>;
}

export class NotificationsDto {
  @IsBoolean() newSale: boolean;
  @IsBoolean() payoutSent: boolean;
  @IsBoolean() weeklySummary: boolean;
  @IsBoolean() productUpdates: boolean;
}

export class ResolveAccountDto {
  @Matches(/^\d{3,6}$/, { message: 'Choose your bank.' })
  bankCode: string;

  @Matches(/^\d{10}$/, { message: 'Account numbers are 10 digits.' })
  accountNumber: string;
}

export class BankDto extends ResolveAccountDto {
  @Trim()
  @IsString()
  @Length(2, 80)
  bankName: string;
}

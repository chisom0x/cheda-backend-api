import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim, Lower } from '../../common/transforms';

export class EmailDto {
  @Lower()
  @IsEmail({}, { message: 'Enter a valid email.' })
  @MaxLength(254)
  email: string;
}

export class SignUpDto extends EmailDto {
  @Trim()
  @IsString()
  @Length(2, 80, { message: 'Enter your name.' })
  name: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password.' })
  @MaxLength(128)
  password: string;

  @IsIn(['seller', 'buyer'])
  intent: 'seller' | 'buyer';

  @IsOptional()
  @Lower()
  @IsString()
  username?: string;
}

export class LoginDto extends EmailDto {
  @IsString()
  @MaxLength(128)
  password: string;
}

export class GoogleDto {
  @IsString()
  @MaxLength(4096)
  idToken: string;
}

export class UpdateAccountDto extends EmailDto {
  @Trim()
  @IsString()
  @Length(2, 80, { message: 'Enter your name.' })
  name: string;
}

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  current?: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password.' })
  @MaxLength(128)
  next: string;
}

export class CodeDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code: string;
}

export class ResetPasswordDto extends EmailDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password.' })
  @MaxLength(128)
  password: string;
}

export class AccessLinkDto {
  @IsString()
  @Length(20, 100)
  token: string;
}

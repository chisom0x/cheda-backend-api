import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorator';
import {
  AccessLinkDto,
  ChangePasswordDto,
  CodeDto,
  EmailDto,
  GoogleDto,
  LoginDto,
  ResetPasswordDto,
  SignUpDto,
  UpdateAccountDto,
} from './auth.dto';
import { AuthService } from './auth.service';

const strict = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle(strict)
  @Post('signup')
  signUp(@Body() dto: SignUpDto) {
    return this.auth.signUp(dto);
  }

  @Throttle(strict)
  @HttpCode(200)
  @Post('login')
  logIn(@Body() dto: LoginDto) {
    return this.auth.logIn(dto);
  }

  @Throttle(strict)
  @HttpCode(200)
  @Post('google')
  google(@Body() dto: GoogleDto) {
    return this.auth.google(dto);
  }

  @Auth('unverified')
  @HttpCode(200)
  @Post('logout')
  logOut(@CurrentUser() user: AuthUser) {
    return this.auth.logOut(user);
  }

  @Auth('unverified')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Auth('unverified')
  @Patch('me')
  updateAccount(@CurrentUser() user: AuthUser, @Body() dto: UpdateAccountDto) {
    return this.auth.updateAccount(user, dto);
  }

  @Auth('unverified')
  @Throttle(strict)
  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user, dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() dto: EmailDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @Throttle(strict)
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Auth('unverified')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('verify-email/request')
  requestEmailVerification(@CurrentUser() user: AuthUser) {
    return this.auth.requestEmailVerification(user);
  }

  @Auth('unverified')
  @Throttle(strict)
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@CurrentUser() user: AuthUser, @Body() dto: CodeDto) {
    return this.auth.verifyEmail(user, dto.code);
  }

  @Throttle(strict)
  @HttpCode(200)
  @Post('access')
  redeemAccessLink(@Body() dto: AccessLinkDto) {
    return this.auth.redeemAccessLink(dto.token);
  }
}

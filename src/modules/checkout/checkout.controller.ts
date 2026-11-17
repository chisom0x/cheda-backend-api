import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  type AuthUser,
  CurrentUser,
} from '../../common/auth/auth.decorator';
import { CheckoutDto, QuoteDto } from './checkout.dto';
import { CheckoutService } from './checkout.service';

@ApiTags('checkout')
@Controller()
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @HttpCode(200)
  @Post('checkout/quote')
  quote(@Body() dto: QuoteDto) {
    return this.checkout.quote(dto);
  }

  @Auth('optional')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  start(@Body() dto: CheckoutDto, @CurrentUser() viewer: AuthUser | null) {
    return this.checkout.start(dto, viewer);
  }

  @Get('checkout/orders/:id')
  result(@Param('id') id: string) {
    return this.checkout.result(id);
  }
}

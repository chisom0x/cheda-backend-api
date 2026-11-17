import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import { PayoutsService } from './payouts.service';

@ApiTags('payouts')
@Auth('seller')
@Controller('me')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('balance')
  balance(@CurrentUser() user: SellerUser) {
    return this.payouts.balance(user.sellerId);
  }

  @Get('payouts')
  list(@CurrentUser() user: SellerUser) {
    return this.payouts.list(user.sellerId);
  }

  /** Requests a withdrawal of the whole available balance, less the withdrawal fee. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('payouts')
  withdraw(@CurrentUser() user: SellerUser) {
    return this.payouts.withdraw(user.sellerId);
  }
}

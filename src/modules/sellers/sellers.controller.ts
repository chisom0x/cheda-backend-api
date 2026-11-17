import { Body, Controller, Get, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  type AuthUser,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import {
  BankDto,
  BecomeSellerDto,
  NotificationsDto,
  ResolveAccountDto,
  StorefrontDto,
  UsernameDto,
  UsernameQueryDto,
} from './sellers.dto';
import { SellersService } from './sellers.service';

@ApiTags('sellers')
@Controller()
export class SellersController {
  constructor(private readonly sellers: SellersService) {}

  @Get('sellers/username-available')
  usernameAvailable(@Query() query: UsernameQueryDto) {
    return this.sellers.usernameAvailability(query.u);
  }

  @Auth()
  @Post('sellers')
  becomeSeller(@CurrentUser() user: AuthUser, @Body() dto: BecomeSellerDto) {
    return this.sellers.becomeSeller(user, dto.username, dto.displayName);
  }

  @Auth('seller')
  @Get('me/seller')
  me(@CurrentUser() user: SellerUser) {
    return this.sellers.me(user);
  }

  @Auth('seller')
  @Patch('me/seller')
  updateStorefront(
    @CurrentUser() user: SellerUser,
    @Body() dto: StorefrontDto,
  ) {
    return this.sellers.updateStorefront(user, dto);
  }

  @Auth('seller')
  @Patch('me/seller/notifications')
  updateNotifications(
    @CurrentUser() user: SellerUser,
    @Body() dto: NotificationsDto,
  ) {
    return this.sellers.updateNotifications(user, dto);
  }

  @Auth('seller')
  @Patch('me/seller/username')
  changeUsername(@CurrentUser() user: SellerUser, @Body() dto: UsernameDto) {
    return this.sellers.changeUsername(user, dto.username);
  }

  @Auth('seller')
  @Get('banks')
  banks() {
    return this.sellers.banks();
  }

  @Auth('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('banks/resolve')
  resolveAccount(@Query() query: ResolveAccountDto) {
    return this.sellers.resolveAccount(query);
  }

  @Auth('seller')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('me/seller/bank')
  saveBank(@CurrentUser() user: SellerUser, @Body() dto: BankDto) {
    return this.sellers.saveBank(user, dto);
  }
}

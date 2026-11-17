import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Auth,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import { CouponActiveDto, CouponInputDto } from './coupons.dto';
import { CouponsService } from './coupons.service';

@ApiTags('coupons')
@Auth('seller')
@Controller('me/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  list(@CurrentUser() user: SellerUser) {
    return this.coupons.list(user.sellerId);
  }

  @Post()
  create(@CurrentUser() user: SellerUser, @Body() dto: CouponInputDto) {
    return this.coupons.create(user.sellerId, dto);
  }

  @Put(':id')
  update(
    @CurrentUser() user: SellerUser,
    @Param('id') id: string,
    @Body() dto: CouponInputDto,
  ) {
    return this.coupons.update(user.sellerId, id, dto);
  }

  @Patch(':id/active')
  setActive(
    @CurrentUser() user: SellerUser,
    @Param('id') id: string,
    @Body() dto: CouponActiveDto,
  ) {
    return this.coupons.setActive(user.sellerId, id, dto.active);
  }

  @Delete(':id')
  remove(@CurrentUser() user: SellerUser, @Param('id') id: string) {
    return this.coupons.remove(user.sellerId, id);
  }
}

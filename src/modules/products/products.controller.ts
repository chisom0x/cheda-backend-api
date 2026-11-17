import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  Auth,
  type AuthUser,
  CurrentUser,
  type SellerUser,
} from '../../common/auth/auth.decorator';
import {
  CourseDto,
  IdsDto,
  ProductInputDto,
  ProductPatchDto,
  ProductQueryDto,
  StatusDto,
  VisitDto,
} from './products.dto';
import { ProductsService } from './products.service';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly products: ProductsService) {}

  @Get('products')
  list(@Query() query: ProductQueryDto) {
    return this.products.list(query);
  }

  @Get('products/:id')
  byId(@Param('id') id: string) {
    return this.products.byId(id);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('products/visits')
  recordVisit(@Body() dto: VisitDto) {
    return this.products.recordVisit(dto.sellerId);
  }

  @Auth('optional')
  @Get('storefronts/:username')
  storefront(
    @Param('username') username: string,
    @CurrentUser() viewer: AuthUser | null,
  ) {
    return this.products.storefront(username, viewer);
  }

  @Auth('optional')
  @Get('storefronts/:username/products/:slug')
  page(
    @Param('username') username: string,
    @Param('slug') slug: string,
    @CurrentUser() viewer: AuthUser | null,
  ) {
    return this.products.page(username, slug, viewer);
  }
}

@ApiTags('seller products')
@Auth('seller')
@Controller('me/products')
export class MyProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  mine(@CurrentUser() user: SellerUser) {
    return this.products.mine(user);
  }

  @Post()
  create(@CurrentUser() user: SellerUser, @Body() dto: ProductInputDto) {
    return this.products.create(user, dto);
  }

  @HttpCode(200)
  @Post('status')
  setStatus(@CurrentUser() user: SellerUser, @Body() dto: StatusDto) {
    return this.products.setStatus(user, dto.ids, dto.status);
  }

  @Delete()
  remove(@CurrentUser() user: SellerUser, @Body() dto: IdsDto) {
    return this.products.remove(user, dto.ids);
  }

  @Get(':id')
  getMine(@CurrentUser() user: SellerUser, @Param('id') id: string) {
    return this.products.getMine(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: SellerUser,
    @Param('id') id: string,
    @Body() dto: ProductPatchDto,
  ) {
    return this.products.update(user, id, dto);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() user: SellerUser, @Param('id') id: string) {
    return this.products.duplicate(user, id);
  }

  @Get(':id/course')
  getCourse(@CurrentUser() user: SellerUser, @Param('id') id: string) {
    return this.products.getCourse(user, id);
  }

  @Put(':id/course')
  saveCourse(
    @CurrentUser() user: SellerUser,
    @Param('id') id: string,
    @Body() dto: CourseDto,
  ) {
    return this.products.saveCourse(user, id, dto);
  }
}

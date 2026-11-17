import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CatalogController, MyProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [SubscriptionsModule],
  controllers: [CatalogController, MyProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ProductCategory,
  ProductStatus,
  ProductType,
} from '../../generated/prisma/client';
import { Trim } from '../../common/transforms';

export const PRODUCT_SORTS = [
  'popular',
  'newest',
  'price-asc',
  'price-desc',
  'rating',
] as const;

export class ProductQueryDto {
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn([...Object.values(ProductCategory), 'All'])
  category?: ProductCategory | 'All';

  @IsOptional()
  @IsIn([...Object.values(ProductType), 'all'])
  type?: ProductType | 'all';

  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort?: (typeof PRODUCT_SORTS)[number];
}

export class FileRefDto {
  @IsString()
  @MaxLength(40)
  id: string;
}

export class ProductInputDto {
  @IsIn(Object.values(ProductType))
  type: ProductType;

  @Trim()
  @IsString()
  @MaxLength(120)
  title: string;

  @Trim()
  @IsString()
  @MaxLength(200)
  tagline: string;

  @IsString()
  @MaxLength(20_000)
  description: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  includes: string[];

  @IsIn(Object.values(ProductCategory))
  category: ProductCategory;

  @IsIn(['NGN'], { message: 'Prices are in naira (NGN) for now.' })
  currency: 'NGN';

  @IsObject()
  pricing: Record<string, unknown>;

  @IsObject()
  cover: Record<string, unknown>;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FileRefDto)
  files: FileRefDto[];

  @IsOptional()
  @IsBoolean()
  downloadable?: boolean;

  @IsOptional()
  @IsBoolean()
  protected?: boolean;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  slug?: string;
}

export class ProductPatchDto {
  @IsOptional() @IsIn(Object.values(ProductType)) type?: ProductType;
  @IsOptional() @Trim() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(200) tagline?: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  includes?: string[];
  @IsOptional()
  @IsIn(Object.values(ProductCategory))
  category?: ProductCategory;
  @IsOptional()
  @IsIn(['NGN'], { message: 'Prices are in naira (NGN) for now.' })
  currency?: 'NGN';
  @IsOptional() @IsObject() pricing?: Record<string, unknown>;
  @IsOptional() @IsObject() cover?: Record<string, unknown>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FileRefDto)
  files?: FileRefDto[];
  @IsOptional() @IsBoolean() downloadable?: boolean;
  @IsOptional() @IsBoolean() protected?: boolean;
  @IsOptional() @Trim() @IsString() @MaxLength(80) slug?: string;
}

export class IdsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  ids: string[];
}

export class StatusDto extends IdsDto {
  @IsIn(Object.values(ProductStatus))
  status: ProductStatus;
}

export class VisitDto {
  @IsString()
  @MaxLength(40)
  sellerId: string;
}

export class LessonDto {
  @IsString() @MaxLength(40) id: string;
  @Trim() @IsString() @MaxLength(160) title: string;
  @IsIn(['video', 'text', 'file']) type: 'video' | 'text' | 'file';
  @IsOptional() @IsInt() @Min(0) @Max(1440) durationMin?: number;
  @IsOptional() @IsString() @MaxLength(100_000) body?: string;
  @IsOptional() @ValidateNested() @Type(() => FileRefDto) file?: FileRefDto;
  @IsBoolean() isFreePreview: boolean;
}

export class ModuleDto {
  @IsString() @MaxLength(40) id: string;
  @Trim()
  @IsString()
  @Length(1, 160, { message: 'Every module needs a title.' })
  title: string;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => LessonDto)
  lessons: LessonDto[];
}

export class CourseDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ModuleDto)
  modules: ModuleDto[];
}

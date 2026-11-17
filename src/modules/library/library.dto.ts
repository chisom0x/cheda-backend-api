import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ProgressDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  completedLessonIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  lastLessonId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  lastPage?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lastPositionSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percent?: number;
}

export type MediaMode = 'download' | 'stream';

export class MediaQueryDto {
  @IsOptional()
  @IsIn(['download', 'stream'])
  mode?: MediaMode;
}

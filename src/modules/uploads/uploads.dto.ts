import {
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Trim } from '../../common/transforms';

export const MAX_FILE_BYTES = 2 * 1024 ** 3;
export const MAX_IMAGE_BYTES = 10 * 1024 ** 2;

export class UploadDto {
  /** stream-media: a video or audio file buyers stream but never download */
  @IsIn(['product-file', 'stream-media', 'image'])
  purpose: 'product-file' | 'stream-media' | 'image';

  @Trim()
  @IsString()
  @Length(1, 255)
  name: string;

  @IsInt()
  @Min(1)
  @Max(MAX_FILE_BYTES)
  size: number;

  @Matches(/^[\w.+-]+\/[\w.+-]+$/, { message: 'Unsupported file type.' })
  mime: string;
}

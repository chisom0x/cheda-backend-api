import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { AuthUser } from '../../common/auth/auth.decorator';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_IMAGE_BYTES, UploadDto } from './uploads.dto';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(user: AuthUser, dto: UploadDto) {
    const isImage = dto.purpose === 'image';
    if (isImage && (!IMAGE_TYPES.has(dto.mime) || dto.size > MAX_IMAGE_BYTES)) {
      throw new BadRequestException(
        'Images must be JPG, PNG or WebP and under 10 MB.',
      );
    }
    const isStream = dto.purpose === 'stream-media';
    if (isStream && !/^(video|audio)\//.test(dto.mime))
      throw new BadRequestException('Choose a video or audio file.');
    if (!isImage && !user.sellerId)
      throw new ForbiddenException('Set up your store to upload products.');

    const visibility = isImage ? 'public' : 'private';
    const ext = extname(dto.name)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '')
      .slice(0, 10);
    const key = `${isImage ? 'images' : 'files'}/${user.id}/${randomUUID()}${ext}`;
    const uploadUrl = await this.storage.presignUpload(
      visibility,
      key,
      dto.mime,
      dto.size,
    );
    const asset = await this.prisma.asset.create({
      data: {
        ownerId: user.id,
        visibility,
        key,
        name: dto.name,
        size: dto.size,
        mime: dto.mime,
        // Streaming media gets an HLS copy that replaces the original
        streamStatus: isStream ? 'pending' : null,
      },
      select: { id: true },
    });
    return {
      uploadUrl,
      headers: { 'Content-Type': dto.mime },
      file: { id: asset.id, name: dto.name, size: dto.size, mime: dto.mime },
      url: isImage ? `${this.storage.publicUrl}/${key}` : null,
    };
  }
}

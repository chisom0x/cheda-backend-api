import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { AuthUser } from '../../common/auth/auth.decorator';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_IMAGE_BYTES, UploadDto } from './uploads.dto';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Larger files are split into parts the browser uploads in parallel. */
const PART_BYTES = 10 * 1024 ** 2;
const MULTIPART_MIN_BYTES = 2 * PART_BYTES;

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
    const multipart = !isImage && dto.size >= MULTIPART_MIN_BYTES;
    const target = multipart
      ? {
          uploadUrl: null,
          multipart: {
            partSize: PART_BYTES,
            ...(await this.storage.presignMultipart(
              key,
              dto.mime,
              Math.ceil(dto.size / PART_BYTES),
            )),
          },
        }
      : {
          uploadUrl: await this.storage.presignUpload(
            visibility,
            key,
            dto.mime,
            dto.size,
          ),
          multipart: null,
        };
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
      ...target,
      headers: { 'Content-Type': dto.mime },
      file: { id: asset.id, name: dto.name, size: dto.size, mime: dto.mime },
      url: isImage ? `${this.storage.publicUrl}/${key}` : null,
    };
  }

  /** Finishes a multipart upload once every part has landed. */
  async complete(user: AuthUser, assetId: string, uploadId: string) {
    const asset = await this.ownAsset(user, assetId);
    const expected = Math.ceil(Number(asset.size) / PART_BYTES);
    const parts = await this.storage
      .completeMultipart(asset.key, uploadId)
      .catch(() => 0);
    if (parts !== expected)
      throw new BadRequestException("The upload didn't finish. Try again.");
    return { id: asset.id };
  }

  /** Drops the parts of a cancelled upload so they aren't stored. */
  async abort(user: AuthUser, assetId: string, uploadId: string) {
    const asset = await this.ownAsset(user, assetId);
    await this.storage.abortMultipart(asset.key, uploadId).catch(() => {});
    return { id: asset.id };
  }

  private async ownAsset(user: AuthUser, id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, ownerId: user.id, visibility: 'private' },
      select: { id: true, key: true, size: true },
    });
    if (!asset) throw new NotFoundException('Upload not found.');
    return asset;
  }
}

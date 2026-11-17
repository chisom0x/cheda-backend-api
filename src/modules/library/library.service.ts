import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../../common/auth/auth.decorator';
import {
  canDownload,
  productInclude,
  toOrder,
  toProduct,
  toProgress,
  toSellerSummary,
} from '../../common/presenters';
import { Prisma } from '../../generated/prisma/client';
import type { Env } from '../../config/env';
import {
  STREAM_TTL_SEC,
  StorageService,
} from '../../integrations/storage.service';
import { FirebaseService } from '../../integrations/firebase.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type StreamPlaylists,
  streamPrefix,
} from '../uploads/transcode.service';
import { MediaMode, ProgressDto } from './library.dto';

type CourseModule = { lessons: { file?: { id: string } }[] };

const summarySelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  verified: true,
  headline: true,
} as const;

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly firebase: FirebaseService,
  ) {}

  async list(user: AuthUser) {
    const orders = await this.prisma.order.findMany({
      where: this.owned(user),
      orderBy: { createdAt: 'desc' },
      distinct: ['productId'],
      include: {
        product: {
          include: { ...productInclude, seller: { select: summarySelect } },
        },
      },
    });
    const progress = await this.prisma.progress.findMany({
      where: {
        userId: user.id,
        productId: { in: orders.map((o) => o.productId) },
      },
    });
    const byProduct = new Map(progress.map((p) => [p.productId, p]));
    return orders.map(({ product, ...order }) => {
      const p = byProduct.get(product.id);
      return {
        order: toOrder(order),
        product: toProduct(product),
        seller: toSellerSummary(product.seller),
        progress: p ? toProgress(p, user.email) : null,
      };
    });
  }

  /** [appCheck]: the request's App Check token; protected products only reveal their content to the app. */
  async get(user: AuthUser, productId: string, appCheck?: string) {
    const order = await this.ownedOrder(user, productId);
    const [product, progress] = await Promise.all([
      this.prisma.product.findUniqueOrThrow({
        where: { id: productId },
        include: {
          ...productInclude,
          seller: { select: summarySelect },
          course: true,
        },
      }),
      this.prisma.progress.findUnique({
        where: { userId_productId: { userId: user.id, productId } },
      }),
    ]);
    // Elsewhere (the website) a protected product shows only its listing, with no lessons to read
    const locked =
      product.protected && !(await this.firebase.isGenuineApp(appCheck));
    return {
      order: toOrder(order),
      product: toProduct(product),
      seller: toSellerSummary(product.seller),
      progress: progress ? toProgress(progress, user.email) : null,
      course:
        product.course && !locked
          ? {
              id: product.course.id,
              productId,
              modules: product.course.modules,
              updatedAt: product.course.updatedAt.toISOString(),
            }
          : null,
    };
  }

  async saveProgress(user: AuthUser, productId: string, dto: ProgressDto) {
    await this.ownedOrder(user, productId);
    const data = {
      ...dto,
      percent: dto.percent === undefined ? undefined : Math.round(dto.percent),
    };
    const progress = await this.prisma.progress.upsert({
      where: { userId_productId: { userId: user.id, productId } },
      create: { userId: user.id, productId, ...data },
      update: data,
    });
    return toProgress(progress, user.email);
  }

  async purchases(user: AuthUser) {
    const orders = await this.prisma.order.findMany({
      where: { ...this.owned(user), status: { not: 'pending' } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return orders.map(toOrder);
  }

  async receipt(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { ...this.owned(user), id: orderId, status: { not: 'pending' } },
      include: { seller: { select: summarySelect } },
    });
    if (!order) throw new NotFoundException('Receipt not found.');
    const { seller, ...rest } = order;
    return { order: toOrder(rest), seller: toSellerSummary(seller) };
  }

  async media(
    user: AuthUser,
    productId: string,
    fileId: string,
    mode: MediaMode,
    appCheck?: string,
  ) {
    const { product, asset } = await this.ownedFile(user, productId, fileId);
    if (product.protected && !(await this.firebase.isGenuineApp(appCheck)))
      throw new ForbiddenException(
        'This product can only be viewed in the Cheda app.',
      );
    if (mode === 'download' && (!canDownload(product) || asset.streamStatus))
      throw new ForbiddenException(
        product.protected
          ? 'This product can only be viewed in the Cheda app.'
          : "This file can't be downloaded.",
      );
    // Once the HLS copy is ready the original is gone; until then it plays as uploaded
    if (asset.streamStatus === 'ready') {
      const token = await this.jwt.signAsync(
        { sub: asset.id },
        { secret: this.streamSecret(), expiresIn: STREAM_TTL_SEC },
      );
      // Path on the API's own origin; clients resolve it against their API base URL
      return {
        fileName: asset.name,
        url: `/api/stream/${token}/master.m3u8`,
        hls: true,
      };
    }
    return {
      fileName: asset.name,
      url: await this.storage.presignDownload(asset.key, asset.name, mode),
      hls: false,
    };
  }

  /**
   * HLS playlists for a video, authorised by the token `media` issued after checking the purchase.
   * The token sits in the path so the browser's native player (iOS Safari) can fetch playlists with
   * no auth header, and relative variant URIs in the master resolve under it. Variant playlists list
   * presigned segment URLs straight from storage.
   */
  async playlist(token: string, variant?: number) {
    const { sub } = await this.jwt
      .verifyAsync<{ sub: string }>(token, { secret: this.streamSecret() })
      .catch(() => {
        throw new ForbiddenException('This video link has expired.');
      });
    const asset = await this.prisma.asset.findUnique({
      where: { id: sub },
      select: { id: true, streamStatus: true, streamPlaylists: true },
    });
    const playlists = asset?.streamPlaylists as StreamPlaylists | null;
    if (!asset || asset.streamStatus !== 'ready' || !playlists)
      throw new NotFoundException('This video is not ready to stream yet.');
    if (variant === undefined) return playlists.master;
    const text = playlists.variants[variant];
    if (text === undefined) throw new NotFoundException('Not found.');
    const prefix = `${streamPrefix(asset.id)}/${variant}`;
    const lines = await Promise.all(
      text
        .split('\n')
        .map(async (line) =>
          line && !line.startsWith('#')
            ? this.storage.presignStream(`${prefix}/${line.trim()}`)
            : line,
        ),
    );
    return lines.join('\n');
  }

  /** Separate from the session secret so a stream token can never pass as a login token. */
  private streamSecret() {
    return `${this.config.get('JWT_SECRET', { infer: true })}:stream`;
  }

  private async ownedFile(user: AuthUser, productId: string, fileId: string) {
    await this.ownedOrder(user, productId);
    const assetSelect = {
      id: true,
      key: true,
      name: true,
      streamStatus: true,
      streamPlaylists: true,
    } as const;
    const [product, attached, course] = await Promise.all([
      this.prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { type: true, downloadable: true, protected: true },
      }),
      this.prisma.productFile.findUnique({
        where: { productId_assetId: { productId, assetId: fileId } },
        select: { asset: { select: assetSelect } },
      }),
      this.prisma.course.findUnique({
        where: { productId },
        select: { modules: true },
      }),
    ]);
    const inLesson = ((course?.modules ?? []) as CourseModule[]).some((m) =>
      m.lessons.some((l) => l.file?.id === fileId),
    );
    const asset =
      attached?.asset ??
      (inLesson
        ? await this.prisma.asset.findUnique({
            where: { id: fileId },
            select: assetSelect,
          })
        : null);
    if (!asset) throw new NotFoundException('File not found.');
    return { product, asset };
  }

  private owned(user: AuthUser): Prisma.OrderWhereInput {
    return {
      status: 'paid',
      OR: [
        { buyerUserId: user.id },
        ...(user.emailVerified ? [{ buyerEmail: user.email }] : []),
      ],
    };
  }

  private async ownedOrder(user: AuthUser, productId: string) {
    const order = await this.prisma.order.findFirst({
      where: { ...this.owned(user), productId },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) throw new ForbiddenException("You don't own this product yet.");
    return order;
  }
}

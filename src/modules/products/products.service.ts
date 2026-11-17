import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser, SellerUser } from '../../common/auth/auth.decorator';
import {
  basePriceOf,
  parseImageSource,
  parsePricing,
} from '../../common/json-fields';
import { isEntitled, isProType, sellableProduct } from '../../common/plans';
import {
  productInclude,
  ProductRecord,
  toProduct,
  toPublicSeller,
  toSellerSummary,
  liveSeller,
} from '../../common/presenters';
import {
  Prisma,
  ProductStatus,
  ProductType,
} from '../../generated/prisma/client';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  CourseDto,
  FileRefDto,
  ModuleDto,
  ProductInputDto,
  ProductPatchDto,
  ProductQueryDto,
} from './products.dto';

const LIST_LIMIT = 100;
const LESSON_TYPES = new Set(['course', 'membership']);
const isPlayable = (mime: string) =>
  mime.startsWith('video/') || mime.startsWith('audio/');

const summarySelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  verified: true,
  headline: true,
} as const;

const SORTS: Record<
  NonNullable<ProductQueryDto['sort']>,
  Prisma.ProductOrderByWithRelationInput[]
> = {
  popular: [{ salesCount: 'desc' }, { id: 'asc' }],
  newest: [{ createdAt: 'desc' }],
  'price-asc': [{ basePrice: 'asc' }, { id: 'asc' }],
  'price-desc': [{ basePrice: 'desc' }, { id: 'asc' }],
  rating: [{ rating: 'desc' }, { id: 'asc' }],
};

export function slugify(input: string) {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function outlineOf(modules: ModuleDto[] | null) {
  if (!modules) return null;
  const lessons = modules.flatMap((m) => m.lessons);
  return {
    modules: modules.map((m) => ({
      id: m.id,
      title: m.title,
      lessons: m.lessons.map(
        ({ id, title, type, durationMin, isFreePreview }) => ({
          id,
          title,
          type,
          durationMin,
          isFreePreview,
        }),
      ),
    })),
    lessonCount: lessons.length,
    totalMinutes: lessons.reduce((sum, l) => sum + (l.durationMin ?? 0), 0),
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(query: ProductQueryDto) {
    const q = query.search;
    const contains = q
      ? { contains: q, mode: 'insensitive' as const }
      : undefined;
    const products = await this.prisma.product.findMany({
      where: {
        status: 'published',
        seller: liveSeller,
        ...(query.category && query.category !== 'All'
          ? { category: query.category }
          : {}),
        ...(query.type && query.type !== 'all' ? { type: query.type } : {}),
        AND: [sellableProduct()],
        ...(contains
          ? {
              OR: [
                { title: contains },
                { tagline: contains },
                { seller: { displayName: contains } },
                { seller: { username: contains } },
              ],
            }
          : {}),
      },
      orderBy: SORTS[query.sort ?? 'popular'],
      take: LIST_LIMIT,
      include: { ...productInclude, seller: { select: summarySelect } },
    });
    return products.map((p) => ({
      product: toProduct(p),
      seller: toSellerSummary(p.seller),
    }));
  }

  async storefront(username: string, viewer: AuthUser | null) {
    const seller = await this.prisma.seller.findUnique({
      where: { username: username.toLowerCase() },
    });
    if (!seller) throw new NotFoundException("We couldn't find that store.");
    // Offline stores (no payout account yet) show buyers an "unavailable" page, not their products
    if (!seller.accountName && viewer?.sellerId !== seller.id)
      return {
        seller: toPublicSeller(seller),
        products: [],
        stats: { products: 0, sales: 0, rating: 0 },
      };
    const products = await this.prisma.product.findMany({
      where: { sellerId: seller.id, status: 'published', ...sellableProduct() },
      orderBy: SORTS.popular,
      take: LIST_LIMIT,
      include: productInclude,
    });
    const rated = products.filter((p) => p.reviewCount > 0);
    return {
      seller: toPublicSeller(seller),
      products: products.map(toProduct),
      stats: {
        products: products.length,
        sales: products.reduce((sum, p) => sum + p.salesCount, 0),
        rating: rated.length
          ? rated.reduce((sum, p) => sum + p.rating, 0) / rated.length
          : 0,
      },
    };
  }

  async page(username: string, slug: string, viewer: AuthUser | null) {
    const seller = await this.prisma.seller.findUnique({
      where: { username: username.toLowerCase() },
      include: { subscription: true },
    });
    const product =
      seller &&
      (await this.prisma.product.findUnique({
        where: { sellerId_slug: { sellerId: seller.id, slug } },
        include: {
          ...productInclude,
          course: { select: { id: true, modules: true } },
        },
      }));
    if (
      !seller ||
      !product ||
      ((product.status !== 'published' ||
        !seller.accountName ||
        (isProType(product.type) && !isEntitled(seller.subscription))) &&
        viewer?.sellerId !== seller.id)
    ) {
      throw new NotFoundException("This product isn't available.");
    }
    const more = await this.prisma.product.findMany({
      where: {
        sellerId: seller.id,
        status: 'published',
        id: { not: product.id },
        ...sellableProduct(),
      },
      orderBy: SORTS.popular,
      take: 3,
      include: productInclude,
    });
    return {
      product: toProduct(product),
      seller: toPublicSeller(seller),
      outline: outlineOf(
        (product.course?.modules as ModuleDto[] | undefined) ?? null,
      ),
      more: more.map(toProduct),
    };
  }

  async byId(id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        status: 'published',
        seller: liveSeller,
        ...sellableProduct(),
      },
      include: { ...productInclude, seller: { select: summarySelect } },
    });
    if (!product)
      throw new NotFoundException("This product isn't available any more.");
    return {
      product: toProduct(product),
      seller: toSellerSummary(product.seller),
    };
  }

  async recordVisit(sellerId: string) {
    const day = new Date(new Date().toISOString().slice(0, 10));
    await this.prisma.visit.upsert({
      where: { sellerId_day: { sellerId, day } },
      create: { sellerId, day, count: 1 },
      update: { count: { increment: 1 } },
    });
    return true;
  }

  async mine(user: SellerUser) {
    const products = await this.prisma.product.findMany({
      where: { sellerId: user.sellerId },
      orderBy: { updatedAt: 'desc' },
      include: productInclude,
    });
    return products.map(toProduct);
  }

  async getMine(user: SellerUser, id: string) {
    return toProduct(await this.own(user.sellerId, id));
  }

  async create(user: SellerUser, dto: ProductInputDto) {
    await this.subscriptions.assertCanCreate(user.sellerId, dto.type);
    const pricing = parsePricing(dto.pricing);
    const assetIds = await this.ownedFiles(user.id, dto.files, dto.type);
    const product = await this.prisma.product.create({
      data: {
        sellerId: user.sellerId,
        slug: await this.uniqueSlug(user.sellerId, dto.slug || dto.title),
        type: dto.type,
        title: dto.title,
        tagline: dto.tagline,
        description: dto.description,
        includes: dto.includes,
        category: dto.category,
        currency: dto.currency,
        pricing,
        basePrice: basePriceOf(pricing),
        cover: parseImageSource(dto.cover, this.storage.publicUrl),
        downloadable: dto.downloadable,
        protected: dto.protected,
        files: {
          create: assetIds.map((assetId, position) => ({ assetId, position })),
        },
        ...(LESSON_TYPES.has(dto.type) ? { course: { create: {} } } : {}),
      },
      include: productInclude,
    });
    return toProduct(product);
  }

  async update(user: SellerUser, id: string, dto: ProductPatchDto) {
    const current = await this.own(user.sellerId, id);
    const type = dto.type ?? current.type;
    if (type !== current.type)
      await this.subscriptions.assertCanCreate(user.sellerId, type);
    const pricing = dto.pricing && parsePricing(dto.pricing);
    const assetIds =
      dto.files && (await this.ownedFiles(user.id, dto.files, type));
    const slugSource =
      dto.slug !== undefined || dto.title !== undefined
        ? dto.slug || dto.title || current.title
        : null;
    const product = await this.prisma.product.update({
      where: { id },
      data: {
        type: dto.type,
        title: dto.title,
        tagline: dto.tagline,
        description: dto.description,
        includes: dto.includes,
        category: dto.category,
        currency: dto.currency,
        ...(pricing ? { pricing, basePrice: basePriceOf(pricing) } : {}),
        cover: dto.cover && parseImageSource(dto.cover, this.storage.publicUrl),
        downloadable: dto.downloadable,
        protected: dto.protected,
        ...(slugSource
          ? { slug: await this.uniqueSlug(user.sellerId, slugSource, id) }
          : {}),
        ...(assetIds
          ? {
              files: {
                deleteMany: {},
                create: assetIds.map((assetId, position) => ({
                  assetId,
                  position,
                })),
              },
            }
          : {}),
      },
      include: productInclude,
    });
    return toProduct(product);
  }

  async setStatus(user: SellerUser, ids: string[], status: ProductStatus) {
    const products = await Promise.all(
      ids.map((id) => this.own(user.sellerId, id)),
    );
    if (status === 'published') {
      products.forEach((p) => this.assertComplete(p));
      await this.assertCoursesHaveLessons(products);
      await this.subscriptions.assertCanPublish(user.sellerId, products);
    }
    await this.prisma.product.updateMany({
      where: { id: { in: ids }, sellerId: user.sellerId },
      data: { status },
    });
    return this.prisma.product
      .findMany({ where: { id: { in: ids } }, include: productInclude })
      .then((list) => list.map(toProduct));
  }

  async duplicate(user: SellerUser, id: string) {
    const source = await this.own(user.sellerId, id);
    await this.subscriptions.assertCanCreate(user.sellerId, source.type);
    const course = await this.prisma.course.findUnique({
      where: { productId: id },
      select: { modules: true },
    });
    const copy = await this.prisma.product.create({
      data: {
        sellerId: user.sellerId,
        slug: await this.uniqueSlug(user.sellerId, `${source.title} copy`),
        type: source.type,
        title: `${source.title} (copy)`.slice(0, 120),
        tagline: source.tagline,
        description: source.description,
        includes: source.includes,
        category: source.category,
        currency: source.currency,
        pricing: source.pricing as Prisma.InputJsonValue,
        basePrice: source.basePrice,
        cover: source.cover as Prisma.InputJsonValue,
        videoDurationSec: source.videoDurationSec,
        downloadable: source.downloadable,
        protected: source.protected,
        files: {
          create: source.files.map(({ asset }, position) => ({
            assetId: asset.id,
            position,
          })),
        },
        ...(course
          ? {
              course: {
                create: { modules: course.modules as Prisma.InputJsonValue },
              },
            }
          : {}),
      },
      include: productInclude,
    });
    return toProduct(copy);
  }

  async remove(user: SellerUser, ids: string[]) {
    await Promise.all(ids.map((id) => this.own(user.sellerId, id)));
    const withOrders = new Set(
      (
        await this.prisma.order.findMany({
          where: { productId: { in: ids } },
          distinct: ['productId'],
          select: { productId: true },
        })
      ).map((o) => o.productId),
    );
    const archive = ids.filter((id) => withOrders.has(id));
    const remove = ids.filter((id) => !withOrders.has(id));
    await this.prisma.$transaction([
      this.prisma.product.updateMany({
        where: { id: { in: archive } },
        data: { status: 'draft' },
      }),
      this.prisma.product.deleteMany({
        where: { id: { in: remove }, sellerId: user.sellerId },
      }),
    ]);
    return { deleted: remove.length, unpublished: archive.length };
  }

  async getCourse(user: SellerUser, productId: string) {
    const product = await this.lessonProduct(user.sellerId, productId);
    const course = await this.prisma.course.upsert({
      where: { productId },
      create: { productId },
      update: {},
    });
    return {
      course: {
        id: course.id,
        productId,
        modules: course.modules as unknown as ModuleDto[],
        updatedAt: course.updatedAt.toISOString(),
      },
      productTitle: product.title,
      productType: product.type,
      status: product.status,
    };
  }

  async saveCourse(user: SellerUser, productId: string, dto: CourseDto) {
    await this.lessonProduct(user.sellerId, productId);
    const saved = await this.withLessonFiles(user.id, dto.modules);
    const modules = saved as unknown as Prisma.InputJsonValue;
    const [course] = await this.prisma.$transaction([
      this.prisma.course.upsert({
        where: { productId },
        create: { productId, modules },
        update: { modules },
      }),
      this.prisma.product.update({
        where: { id: productId },
        data: { updatedAt: new Date() },
      }),
    ]);
    return {
      id: course.id,
      productId,
      modules: saved,
      updatedAt: course.updatedAt.toISOString(),
    };
  }

  private async withLessonFiles(ownerId: string, modules: ModuleDto[]) {
    const ids = [
      ...new Set(
        modules.flatMap((m) =>
          m.lessons.flatMap((l) =>
            l.type !== 'text' && l.file ? [l.file.id] : [],
          ),
        ),
      ),
    ];
    const assets = new Map(
      (
        await this.prisma.asset.findMany({
          where: { id: { in: ids }, ownerId, visibility: 'private' },
          select: { id: true, name: true, size: true, mime: true },
        })
      ).map((a) => [a.id, { ...a, size: Number(a.size) }]),
    );
    return modules.map((m) => ({
      ...m,
      lessons: m.lessons.map(({ file, ...lesson }) => {
        if (lesson.type === 'text' || !file) return lesson;
        const asset = assets.get(file.id);
        if (!asset) {
          throw new BadRequestException(
            `The file for "${lesson.title}" is missing. Upload it again.`,
          );
        }
        if (lesson.type === 'video' && !asset.mime.startsWith('video/')) {
          throw new BadRequestException(
            `"${lesson.title}" needs a video file (MP4, MOV or WebM).`,
          );
        }
        return { ...lesson, file: asset };
      }),
    }));
  }

  private async own(sellerId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, sellerId },
      include: productInclude,
    });
    if (!product) throw new NotFoundException('Product not found.');
    return product;
  }

  private async lessonProduct(sellerId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, sellerId },
      select: { title: true, type: true, status: true },
    });
    if (!product) throw new NotFoundException('Product not found.');
    if (!LESSON_TYPES.has(product.type))
      throw new BadRequestException(
        'Only courses and memberships have lessons.',
      );
    return product;
  }

  private assertComplete(p: ProductRecord) {
    if (!p.title.trim() || !p.description.trim())
      throw new BadRequestException(
        'Add a title and description before publishing.',
      );
    if (
      p.type === 'media' &&
      (p.files.length !== 1 || !isPlayable(p.files[0].asset.mime))
    )
      throw new BadRequestException(
        'Upload one audio or video file before publishing.',
      );
    if (!LESSON_TYPES.has(p.type) && p.files.length === 0)
      throw new BadRequestException(
        'Upload at least one file before publishing.',
      );
  }

  /** Courses sell their lessons, so an empty one can't go live. Memberships may launch before their first post. */
  private async assertCoursesHaveLessons(products: ProductRecord[]) {
    const ids = products.filter((p) => p.type === 'course').map((p) => p.id);
    if (!ids.length) return;
    const courses = await this.prisma.course.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, modules: true },
    });
    const withLessons = new Set(
      courses
        .filter((c) =>
          ((c.modules as ModuleDto[] | null) ?? []).some(
            (m) => m.lessons.length > 0,
          ),
        )
        .map((c) => c.productId),
    );
    if (ids.some((id) => !withLessons.has(id)))
      throw new BadRequestException(
        'Add at least one lesson in the course builder before publishing.',
      );
  }

  private async ownedFiles(
    ownerId: string,
    refs: FileRefDto[],
    type: ProductType,
  ) {
    const ids = [...new Set(refs.map((f) => f.id))];
    if (type === 'media' && ids.length > 1)
      throw new BadRequestException(
        'An audio or video product has a single file.',
      );
    if (!ids.length) return [];
    const assets = await this.prisma.asset.findMany({
      where: { id: { in: ids }, ownerId, visibility: 'private' },
      select: { mime: true },
    });
    if (assets.length !== ids.length)
      throw new BadRequestException(
        'One of your files is missing. Upload it again.',
      );
    if (type === 'media' && !isPlayable(assets[0].mime))
      throw new BadRequestException('Upload an audio or video file.');
    return ids;
  }

  private async uniqueSlug(
    sellerId: string,
    source: string,
    exceptId?: string,
  ) {
    const base = slugify(source) || 'product';
    const taken = new Set(
      (
        await this.prisma.product.findMany({
          where: {
            sellerId,
            slug: { startsWith: base },
            ...(exceptId ? { id: { not: exceptId } } : {}),
          },
          select: { slug: true },
        })
      ).map((p) => p.slug),
    );
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    return slug;
  }
}

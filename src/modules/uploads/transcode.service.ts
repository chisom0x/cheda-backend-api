import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { StorageService } from '../../integrations/storage.service';
import { PrismaService } from '../../prisma/prisma.service';

const run = promisify(execFile);

/**
 * Renditions by the video's short side; only those at or below the source are made.
 * Quality-targeted (CRF) with a bitrate ceiling, so slides and talking heads stay small
 * while busy scenes are capped at `maxrate` kbps.
 */
const LADDER = [
  { size: 360, maxrate: 500, audio: 96 },
  { size: 720, maxrate: 1500, audio: 128 },
  { size: 1080, maxrate: 3000, audio: 128 },
];
const AUDIO_ONLY_KBPS = 128;
const CRF = 23;
const SEGMENT_SEC = 6;
const UPLOAD_CONCURRENCY = 6;
/** A claim older than this belongs to a worker that died mid-transcode. */
const STALE_CLAIM_MS = 3 * 60 * 60 * 1000;
/** Presigned uploads that never landed are given up on after this. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;

export type StreamPlaylists = { master: string; variants: string[] };

export const streamPrefix = (assetId: string) => `hls/${assetId}`;

/**
 * Turns streaming-only videos into adaptive HLS (several qualities in 6s segments), and streaming-only
 * audio into single-rendition HLS, in the private bucket. Then deletes the original upload: buyers can
 * only stream these, so it would just be paid-for storage.
 */
@Injectable()
export class TranscodeService implements OnModuleInit {
  private readonly logger = new Logger(TranscodeService.name);
  private enabled = false;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    try {
      await run('ffmpeg', ['-version']);
      await run('ffprobe', ['-version']);
      this.enabled = true;
    } catch {
      this.logger.warn(
        'ffmpeg/ffprobe not found on PATH: videos will play without adaptive streaming until it is installed.',
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'video-transcode' })
  async tick() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      // Drain the queue one video at a time; ffmpeg already uses every core
      while (await this.next());
    } finally {
      this.busy = false;
    }
  }

  /** Claims and transcodes one pending video. Returns false when there is nothing left to do. */
  private async next() {
    const candidates = await this.prisma.asset.findMany({
      where: {
        OR: [
          { streamStatus: 'pending' },
          {
            streamStatus: 'processing',
            streamClaimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true,
        key: true,
        createdAt: true,
        streamStatus: true,
        streamClaimedAt: true,
      },
    });
    for (const asset of candidates) {
      // Atomic claim so several API instances never transcode the same file
      const claimed = await this.prisma.asset.updateMany({
        where: {
          id: asset.id,
          streamStatus: asset.streamStatus,
          streamClaimedAt: asset.streamClaimedAt,
        },
        data: { streamStatus: 'processing', streamClaimedAt: new Date() },
      });
      if (!claimed.count) continue;

      if (!(await this.storage.exists(asset.key))) {
        // The browser upload hasn't finished (or never will)
        const abandoned = Date.now() - asset.createdAt.getTime() > ABANDONED_MS;
        await this.prisma.asset.update({
          where: { id: asset.id },
          data: {
            streamStatus: abandoned ? 'failed' : 'pending',
            streamClaimedAt: abandoned ? new Date() : null,
          },
        });
        continue;
      }

      try {
        const playlists = await this.transcode(asset.id, asset.key);
        await this.prisma.asset.update({
          where: { id: asset.id },
          data: { streamStatus: 'ready', streamPlaylists: playlists },
        });
        this.logger.log(`Video ${asset.id} is ready to stream.`);
      } catch (e) {
        this.logger.error(
          `Transcoding video ${asset.id} failed: ${(e as Error).message}`,
        );
        await this.prisma.asset.update({
          where: { id: asset.id },
          data: { streamStatus: 'failed' },
        });
        return true;
      }
      // Only once the stream is live; a failed transcode keeps the original so it still plays
      await this.storage
        .delete(asset.key)
        .catch((e: Error) =>
          this.logger.warn(
            `Couldn't delete the original of video ${asset.id}: ${e.message}`,
          ),
        );
      return true;
    }
    return false;
  }

  private async transcode(
    assetId: string,
    key: string,
  ): Promise<StreamPlaylists> {
    const dir = await mkdtemp(join(tmpdir(), 'cheda-hls-'));
    try {
      const source = join(dir, 'source');
      await this.storage.downloadTo(key, source);
      const { shortSide, hasAudio } = await probe(source);
      const out = join(dir, 'out');
      let variants: number;
      if (shortSide === null) {
        await ffmpeg(audioHlsArgs(source, out));
        variants = 1;
      } else {
        const ladder = LADDER.filter((r) => r.size <= shortSide);
        if (!ladder.length)
          ladder.push({ ...LADDER[0], size: shortSide - (shortSide % 2) });
        await ffmpeg(hlsArgs(source, out, ladder, hasAudio));
        variants = ladder.length;
      }

      const files: string[] = [];
      for (let v = 0; v < variants; v++) {
        for (const name of await readdir(join(out, String(v)))) {
          if (name.endsWith('.ts')) files.push(`${v}/${name}`);
        }
      }
      await pool(files, UPLOAD_CONCURRENCY, (file) =>
        this.storage.uploadFrom(
          join(out, file),
          `${streamPrefix(assetId)}/${file}`,
          'video/mp2t',
        ),
      );

      return {
        master: await readFile(join(out, 'master.m3u8'), 'utf8'),
        variants: await Promise.all(
          Array.from({ length: variants }, (_, v) =>
            readFile(join(out, String(v), 'index.m3u8'), 'utf8'),
          ),
        ),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function probe(path: string) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height:stream_disposition=attached_pic',
    '-of',
    'json',
    path,
  ]);
  const { streams = [] } = JSON.parse(stdout) as {
    streams?: {
      codec_type: string;
      width?: number;
      height?: number;
      disposition?: { attached_pic?: number };
    }[];
  };
  // Cover art embedded in an MP3/M4A shows up as a one-frame video stream
  const video = streams.find(
    (s) =>
      s.codec_type === 'video' &&
      !s.disposition?.attached_pic &&
      s.width &&
      s.height,
  );
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  if (!video && !hasAudio) throw new Error('No audio or video stream.');
  return {
    /** null for audio-only files */
    shortSide: video ? Math.min(video.width!, video.height!) : null,
    hasAudio,
  };
}

function audioHlsArgs(source: string, out: string) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    `${AUDIO_ONLY_KBPS}k`,
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SEC),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(out, '%v', 'seg_%04d.ts'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    'a:0',
    join(out, '%v', 'index.m3u8'),
  ];
}

function hlsArgs(
  source: string,
  out: string,
  ladder: typeof LADDER,
  hasAudio: boolean,
) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source];
  ladder.forEach(() => {
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a:0');
  });
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    // Keyframe on every segment boundary so quality switches are seamless
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEGMENT_SEC})`,
    '-sc_threshold',
    '0',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-ac', '2');
  ladder.forEach((r, i) => {
    // Scale the short side so portrait videos get the same quality steps
    const s = r.size;
    args.push(
      `-filter:v:${i}`,
      `scale=w='if(gt(iw,ih),-2,${s})':h='if(gt(iw,ih),${s},-2)'`,
      `-crf:v:${i}`,
      String(CRF),
      `-maxrate:v:${i}`,
      `${r.maxrate}k`,
      `-bufsize:v:${i}`,
      `${r.maxrate * 2}k`,
    );
    if (hasAudio) args.push(`-b:a:${i}`, `${r.audio}k`);
  });
  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SEC),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(out, '%v', 'seg_%04d.ts'),
    '-master_pl_name',
    'master.m3u8',
    '-var_stream_map',
    ladder.map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
    join(out, '%v', 'index.m3u8'),
  );
  return args;
}

function ffmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
    );
  });
}

async function pool<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<unknown>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

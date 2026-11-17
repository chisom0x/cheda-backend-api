import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Env } from '../config/env';

const UPLOAD_TTL_SEC = 15 * 60;
const DOWNLOAD_TTL_SEC = 5 * 60;
export const STREAM_TTL_SEC = 4 * 60 * 60;

@Injectable()
export class StorageService {
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get publicUrl() {
    return this.config
      .get('STORAGE_PUBLIC_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  bucket(visibility: 'public' | 'private') {
    return this.config.get(
      visibility === 'public'
        ? 'STORAGE_PUBLIC_BUCKET'
        : 'STORAGE_PRIVATE_BUCKET',
      { infer: true },
    );
  }

  presignUpload(
    visibility: 'public' | 'private',
    key: string,
    mime: string,
    size: number,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.bucket(visibility),
      Key: key,
      ContentType: mime,
      ContentLength: size,
    });
    return getSignedUrl(this.s3(), command, {
      expiresIn: UPLOAD_TTL_SEC,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  presignDownload(key: string, fileName: string, mode: 'download' | 'stream') {
    const disposition = mode === 'stream' ? 'inline' : 'attachment';
    const command = new GetObjectCommand({
      Bucket: this.bucket('private'),
      Key: key,
      ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    return getSignedUrl(this.s3(), command, {
      expiresIn: mode === 'stream' ? STREAM_TTL_SEC : DOWNLOAD_TTL_SEC,
    });
  }

  /** Signed GET for an HLS segment; no disposition so it stays cacheable by key. */
  presignStream(key: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket('private'),
      Key: key,
    });
    return getSignedUrl(this.s3(), command, { expiresIn: STREAM_TTL_SEC });
  }

  async exists(key: string) {
    try {
      await this.s3().send(
        new HeadObjectCommand({ Bucket: this.bucket('private'), Key: key }),
      );
      return true;
    } catch (e) {
      if (e instanceof NotFound) return false;
      throw e;
    }
  }

  async downloadTo(key: string, path: string) {
    const res = await this.s3().send(
      new GetObjectCommand({ Bucket: this.bucket('private'), Key: key }),
    );
    await pipeline(res.Body as Readable, createWriteStream(path));
  }

  /** For small files (HLS segments): a buffered body lets the SDK retry transient storage errors, a stream can't be replayed. */
  async uploadFrom(path: string, key: string, mime: string) {
    await this.s3().send(
      new PutObjectCommand({
        Bucket: this.bucket('private'),
        Key: key,
        Body: await readFile(path),
        ContentType: mime,
      }),
    );
  }

  async delete(key: string) {
    await this.s3().send(
      new DeleteObjectCommand({ Bucket: this.bucket('private'), Key: key }),
    );
  }

  private s3() {
    if (this.client) return this.client;
    const keyId = this.config.get('STORAGE_ACCESS_KEY_ID', { infer: true });
    const secret = this.config.get('STORAGE_SECRET_ACCESS_KEY', {
      infer: true,
    });
    const endpoint = this.config.get('STORAGE_ENDPOINT', { infer: true });
    if (
      !keyId ||
      !secret ||
      !endpoint ||
      !this.bucket('private') ||
      !this.bucket('public') ||
      !this.publicUrl
    ) {
      throw new ServiceUnavailableException('File storage is not configured.');
    }
    this.client = new S3Client({
      endpoint,
      region: this.config.get('STORAGE_REGION', { infer: true }),
      credentials: { accessKeyId: keyId, secretAccessKey: secret },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    return this.client;
  }
}

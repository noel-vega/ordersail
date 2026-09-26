import { Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from 'logging';
import { createStorageClient } from 'storage';
import { env } from '../env';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  // accessKeyId/secretAccessKey are only passed when explicitly set (e.g. local
  // MinIO); omitted in prod so the AWS SDK falls back to the default credential
  // chain and picks up the ECS task role instead of a static key pair
  private readonly client = createStorageClient({
    endpoint: env.MINIO_ENDPOINT,
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
    bucket: env.MINIO_BUCKET,
    publicBaseUrl: env.MINIO_PUBLIC_BASE_URL,
    forcePathStyle: env.MINIO_FORCE_PATH_STYLE
      ? env.MINIO_FORCE_PATH_STYLE === 'true'
      : undefined,
  });

  // local dev needs zero manual MinIO console setup — same zero-friction
  // bar as Mailpit needing no setup to receive mail
  async onModuleInit() {
    try {
      await this.client.ensureBucket();
    } catch (err: unknown) {
      this.logger.warn(
        { err, event: 'storage.bucket_ensure_failed' },
        'Failed to ensure storage bucket exists',
      );
    }
  }

  getUploadUrl(key: string, contentType: string) {
    return this.client.getUploadUrl(key, contentType);
  }

  getPublicUrl(key: string) {
    return this.client.getPublicUrl(key);
  }

  // best-effort — the DB row is the source of truth for what's "deleted";
  // a lingering object in the bucket after a failed delete isn't visible to
  // any user-facing flow
  async deleteObject(key: string) {
    try {
      await this.client.deleteObject(key);
    } catch (err: unknown) {
      this.logger.warn(
        { err, event: 'storage.object_delete_failed', key },
        'Failed to delete storage object',
      );
    }
  }
}

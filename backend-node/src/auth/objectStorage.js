import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const safeKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200 || !safeKeyPattern.test(key)
      || key.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('Invalid storage key.');
  }
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length > 200 || prefix.startsWith('/') || prefix.includes('..') || prefix.includes('//')) {
    throw new TypeError('Invalid storage key prefix.');
  }
  if (prefix && !safeKeyPattern.test(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) {
    throw new TypeError('Invalid storage key prefix.');
  }
}

export function createObjectStorage(env, { s3Client = null } = {}) {
  if (env.STORAGE_PROVIDER === 's3') {
    validatePrefix(env.STORAGE_S3_KEY_PREFIX ?? '');
    const client = s3Client ?? new S3Client({
      region: env.STORAGE_S3_REGION,
      endpoint: env.STORAGE_S3_ENDPOINT,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.STORAGE_S3_ACCESS_KEY, secretAccessKey: env.STORAGE_S3_SECRET_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    const bucket = env.STORAGE_S3_BUCKET;
    const prefix = env.STORAGE_S3_KEY_PREFIX ? `${env.STORAGE_S3_KEY_PREFIX.replace(/\/+$/, '')}/` : '';
    const keyFor = (key) => { validateKey(key); return `${prefix}${key}`; };
    return {
      async put(key, body, contentType) {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), Body: body, ContentType: contentType }));
      },
      async openRead(key) {
        try { return (await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }))).Body ?? null; }
        catch (error) {
          if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
          throw error;
        }
      },
      async delete(key) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(key) }));
      },
      async *list() {
        let continuationToken;
        do {
          const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: continuationToken,
          }));
          for (const object of result.Contents ?? []) {
            if (typeof object.Key !== 'string' || !object.LastModified) continue;
            const key = prefix && object.Key.startsWith(prefix) ? object.Key.slice(prefix.length) : object.Key;
            if (!key) continue;
            yield { key, sizeBytes: Number(object.Size ?? 0), lastModifiedUtc: object.LastModified };
          }
          continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
        } while (continuationToken);
      },
      close() { client.destroy(); },
    };
  }

  const root = path.resolve(env.STORAGE_LOCAL_ROOT ?? './data/media');
  const resolve = (key) => {
    validateKey(key);
    const fullPath = path.resolve(root, ...key.split('/'));
    if (!fullPath.startsWith(`${root}${path.sep}`)) throw new TypeError('Storage key escapes the storage root.');
    return fullPath;
  };
  return {
    async put(key, body) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, body, { flag: 'wx' });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async openRead(key) {
      try { return Readable.from(await readFile(resolve(key))); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
    async *list() {
      async function* walk(directory, keyPrefix = '') {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if (error?.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          const fullPath = path.join(directory, entry.name);
          const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) yield* walk(fullPath, key);
          else if (entry.isFile()) {
            const info = await stat(fullPath);
            yield { key, sizeBytes: info.size, lastModifiedUtc: info.mtime };
          }
        }
      }
      yield* walk(root);
    },
    close() {},
  };
}

export { validateKey, validatePrefix };
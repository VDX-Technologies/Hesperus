// Object storage for the immutable raw archive. R2 (or any S3 API) in production, memory in
// tests. Writes never overwrite: put fails with "exists" so the caller picks another key.
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export interface ObjectStore {
  /** Creates key; returns false if it already exists (never overwrites). */
  putNew(key: string, body: Uint8Array, contentType: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  /** Total objects and bytes under prefix. */
  usage(prefix: string): Promise<{ objects: number; bytes: number }>;
}

export interface StoreOps {
  writes: number; // class A: put, list
  reads: number; // class B: get
}

/** Counts the operations made through a store, for the monthly quota (engine_usage). */
export class MeteredStore implements ObjectStore {
  ops: StoreOps = { writes: 0, reads: 0 };
  constructor(private inner: ObjectStore) {}
  putNew(key: string, body: Uint8Array, contentType: string) {
    this.ops.writes++;
    return this.inner.putNew(key, body, contentType);
  }
  get(key: string) {
    this.ops.reads++;
    return this.inner.get(key);
  }
  list(prefix: string) {
    this.ops.writes++;
    return this.inner.list(prefix);
  }
  usage(prefix: string) {
    this.ops.writes++;
    return this.inner.usage(prefix);
  }
}

export class MemoryStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  async putNew(key: string, body: Uint8Array) {
    if (this.objects.has(key)) return false;
    this.objects.set(key, body);
    return true;
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async usage(prefix: string) {
    const keys = await this.list(prefix);
    return { objects: keys.length, bytes: keys.reduce((n, k) => n + this.objects.get(k)!.length, 0) };
  }
}

export class S3Store implements ObjectStore {
  constructor(
    private s3: S3Client,
    private bucket: string,
  ) {}

  async putNew(key: string, body: Uint8Array, contentType: string) {
    try {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, IfNoneMatch: "*" }),
      );
      return true;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412) return false;
      throw e;
    }
  }

  async get(key: string) {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = out.NextContinuationToken;
    } while (token);
    return keys.sort();
  }

  async usage(prefix: string) {
    let objects = 0, bytes = 0;
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) {
        objects++;
        bytes += o.Size ?? 0;
      }
      token = out.NextContinuationToken;
    } while (token);
    return { objects, bytes };
  }
}

/** R2 from env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT overrides). */
export function storeFromEnv(): ObjectStore {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error("R2 credentials are not set");
  const s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return new S3Store(s3, R2_BUCKET);
}

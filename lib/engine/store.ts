// Object storage for the immutable raw archive. R2 (or any S3 API) in production, a local folder in development, memory in
// tests. Writes never overwrite: put fails with "exists" so the caller picks another key. Only the
// orphan sweep deletes (sweepOrphanDocuments, lib/engine/archive.ts).
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ObjectStore {
  /** Creates key; returns false if it already exists (never overwrites). */
  putNew(key: string, body: Uint8Array, contentType: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  /** Total objects and bytes under prefix. */
  usage(prefix: string): Promise<{ objects: number; bytes: number }>;
  /** Keys under prefix with their size and when they were written. */
  entries(prefix: string): Promise<StoreEntry[]>;
  /** Removes key; a missing key is not an error. */
  delete(key: string): Promise<void>;
}

export interface StoreEntry { key: string; size: number; modified: Date }

export interface StoreOps {
  writes: number; // class A: put, list
  reads: number; // class B: get
  bytes: number; // written by successful putNew
  objects: number; // created by successful putNew
}

/**
 * Counts the operations made through a store, for the monthly quota (engine_usage), and the bytes
 * it added, for the storage size (engine_gauges).
 */
export class MeteredStore implements ObjectStore {
  ops: StoreOps = { writes: 0, reads: 0, bytes: 0, objects: 0 };
  constructor(private inner: ObjectStore) {}
  async putNew(key: string, body: Uint8Array, contentType: string) {
    this.ops.writes++;
    const created = await this.inner.putNew(key, body, contentType);
    if (created) {
      this.ops.bytes += body.length;
      this.ops.objects++;
    }
    return created;
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
  entries(prefix: string) {
    this.ops.writes++;
    return this.inner.entries(prefix);
  }
  // deletes are free on R2
  delete(key: string) {
    return this.inner.delete(key);
  }
}

export class MemoryStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  modified = new Map<string, Date>();
  async putNew(key: string, body: Uint8Array) {
    if (this.objects.has(key)) return false;
    this.objects.set(key, body);
    this.modified.set(key, new Date());
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
  async entries(prefix: string) {
    return (await this.list(prefix)).map((key) => ({ key, size: this.objects.get(key)!.length, modified: this.modified.get(key)! }));
  }
  async delete(key: string) {
    this.objects.delete(key);
    this.modified.delete(key);
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

  async entries(prefix: string) {
    const entries: StoreEntry[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of out.Contents ?? []) if (o.Key) entries.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified ?? new Date() });
      token = out.NextContinuationToken;
    } while (token);
    return entries;
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Objects as files under a folder: for development with no R2 at hand. */
export class FileStore implements ObjectStore {
  constructor(private root: string) {}

  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("key outside the store");
    return p;
  }

  async putNew(key: string, body: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    try {
      await writeFile(p, body, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch {
      return null;
    }
  }

  async list(prefix: string) {
    const files = await readdir(this.root, { recursive: true, withFileTypes: true }).catch(() => []);
    return files
      .filter((f) => f.isFile())
      .map((f) => relative(this.root, join(f.parentPath, f.name)).split(sep).join("/"))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  async usage(prefix: string) {
    let objects = 0, bytes = 0;
    for (const k of await this.list(prefix)) {
      objects++;
      bytes += (await stat(this.path(k))).size;
    }
    return { objects, bytes };
  }

  async entries(prefix: string) {
    const entries: StoreEntry[] = [];
    for (const key of await this.list(prefix)) {
      const s = await stat(this.path(key));
      entries.push({ key, size: s.size, modified: s.mtime });
    }
    return entries;
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/**
 * R2 from env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT overrides).
 * Outside production with no R2 set, files go to .data/store in the project folder.
 */
export function storeFromEnv(): ObjectStore {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    if (process.env.NODE_ENV !== "production") return new FileStore(join(process.cwd(), ".data", "store"));
    throw new Error("R2 credentials are not set");
  }
  const s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return new S3Store(s3, R2_BUCKET);
}

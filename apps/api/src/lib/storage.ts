import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Object storage behind one interface. Local disk in development; an
 * S3-compatible adapter (Cloudflare R2) slots in for production.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Removes every object under a prefix (an image's folder of widths). */
  deletePrefix(prefix: string): Promise<void>;
  url(key: string): string;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error(`Unsafe storage key: ${key}`);
}

export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(root: string, private readonly publicBase = "/media") {
    this.root = resolve(root);
  }
  private path(key: string) {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("Path escapes storage root");
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async deletePrefix(prefix: string) {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
  url(key: string) {
    assertKey(key);
    return `${this.publicBase}/${key}`;
  }
  get rootDir() {
    return this.root;
  }
}

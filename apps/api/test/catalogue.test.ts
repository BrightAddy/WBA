import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeJpeg, post, resetDb, send, setupTestApp, signIn, signUpSeller, upload } from "./helpers.ts";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let kofi: string;
let ama: string;

beforeAll(async () => (t = await setupTestApp()));
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});
beforeEach(async () => {
  await resetDb(t.db);
  t.sender.sent.clear();
  kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  ama = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
});

const product = (imageIds: string[] = [], extra: object = {}) => ({
  title: "Carhartt hoodie",
  category: "Hoodies and jackets",
  pricePesewas: 8500,
  variants: [
    { size: "M", stock: 2 },
    { size: "L", stock: 1 },
  ],
  imageIds,
  ...extra,
});

describe("image uploads", () => {
  it("re-encodes to WebP renditions, strips EXIF and returns a ThumbHash", async () => {
    const r = await upload(t.app, kofi, await makeJpeg(2000, 1500));
    expect(r.statusCode).toBe(201);
    const { image } = r.json();
    expect(Object.keys(image.urls).map(Number)).toEqual([320, 720, 1440]);
    expect(image.thumbhash).toMatch(/^[A-Za-z0-9+/=]+$/);

    const dir = join(t.storage.rootDir, image.urls[1440].replace("/media/", "").replace("/1440.webp", ""));
    expect(readdirSync(dir).sort()).toEqual(["1440.webp", "320.webp", "720.webp"]);
    const meta = await sharp(join(dir, "1440.webp")).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(1440);
  });

  it("applies EXIF orientation so portrait phone photos stand upright", async () => {
    const r = await upload(t.app, kofi, await makeJpeg(1200, 800, 6));
    expect(r.json().image).toMatchObject({ width: 800, height: 1200 });
  });

  it("doesn't upscale small photos", async () => {
    const r = await upload(t.app, kofi, await makeJpeg(600, 600));
    expect(Object.keys(r.json().image.urls).map(Number)).toEqual([320, 600]);
  });

  it("rejects files that aren't images, whatever they claim to be", async () => {
    const r = await upload(t.app, kofi, Buffer.from("<?php echo 'hi'; ?>"), "photo.jpg", "image/jpeg");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_image");
  });

  it("requires a store", async () => {
    const noStore = await signIn(t.app, t.sender, "0201112222");
    const r = await upload(t.app, noStore, await makeJpeg());
    expect(r.statusCode).toBe(409);
  });
});

describe("products", () => {
  it("creates a draft with photo order and variants", async () => {
    const a = (await upload(t.app, kofi, await makeJpeg())).json().image.id;
    const b = (await upload(t.app, kofi, await makeJpeg())).json().image.id;
    const r = await post(t.app, "/api/seller/products", product([b, a]), kofi);
    expect(r.statusCode).toBe(201);
    const p = r.json().product;
    expect(p.status).toBe("draft");
    expect(p.images.map((i: { id: string }) => i.id)).toEqual([b, a]);
    expect(p.variants.map((v: { size: string }) => v.size)).toEqual(["M", "L"]);
    expect(p.totalStock).toBe(3);

    const list = (await send(t.app, "GET", "/api/seller/products", kofi)).json().products;
    expect(list).toHaveLength(1);
    expect(list[0].cover.id).toBe(b);
  });

  it("updates variants in place, including swapping sizes", async () => {
    const created = (await post(t.app, "/api/seller/products", product(), kofi)).json().product;
    const [m, l] = created.variants;
    const r = await send(t.app, "PUT", `/api/seller/products/${created.id}`, kofi, product([], {
      variants: [
        { id: m.id, size: "L", stock: 5 },
        { id: l.id, size: "M", stock: 0 },
        { size: "XL", stock: 3 },
      ],
    }));
    expect(r.statusCode).toBe(200);
    const v = r.json().product.variants;
    expect(v.map((x: { id: string; size: string }) => [x.id, x.size])).toEqual([[m.id, "L"], [l.id, "M"], [v[2].id, "XL"]]);
  });

  it("removes dropped photos from storage on save", async () => {
    const img = (await upload(t.app, kofi, await makeJpeg())).json().image;
    const created = (await post(t.app, "/api/seller/products", product([img.id]), kofi)).json().product;
    const dir = join(t.storage.rootDir, img.urls[320].replace("/media/", "").replace("/320.webp", ""));
    expect(readdirSync(dir).length).toBeGreaterThan(0);

    await send(t.app, "PUT", `/api/seller/products/${created.id}`, kofi, product([]));
    expect(() => readdirSync(dir)).toThrow();
  });

  it("won't publish without a photo, and won't let a live product lose its photos", async () => {
    const draft = (await post(t.app, "/api/seller/products", product(), kofi)).json().product;
    const blocked = await post(t.app, `/api/seller/products/${draft.id}/status`, { status: "active" }, kofi);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("publish_blocked");

    const img = (await upload(t.app, kofi, await makeJpeg())).json().image.id;
    await send(t.app, "PUT", `/api/seller/products/${draft.id}`, kofi, product([img]));
    const live = await post(t.app, `/api/seller/products/${draft.id}/status`, { status: "active" }, kofi);
    expect(live.json().product.status).toBe("active");

    const strip = await send(t.app, "PUT", `/api/seller/products/${draft.id}`, kofi, product([]));
    expect(strip.statusCode).toBe(400);
  });

  it("rejects bad input with field errors", async () => {
    const r = await post(t.app, "/api/seller/products", product([], { pricePesewas: 0, variants: [] }), kofi);
    expect(r.statusCode).toBe(400);
    expect(Object.keys(r.json().error.fields)).toEqual(expect.arrayContaining(["pricePesewas", "variants"]));
  });
});

describe("isolation between sellers", () => {
  it("hides and protects another seller's products", async () => {
    const mine = (await post(t.app, "/api/seller/products", product(), kofi)).json().product;
    expect((await send(t.app, "GET", `/api/seller/products/${mine.id}`, ama)).statusCode).toBe(404);
    expect((await send(t.app, "PUT", `/api/seller/products/${mine.id}`, ama, product())).statusCode).toBe(404);
    expect((await post(t.app, `/api/seller/products/${mine.id}/status`, { status: "archived" }, ama)).statusCode).toBe(404);
    expect((await send(t.app, "GET", "/api/seller/products", ama)).json().products).toEqual([]);
  });

  it("won't attach another seller's photo or variant", async () => {
    const kofiImg = (await upload(t.app, kofi, await makeJpeg())).json().image.id;
    const r = await post(t.app, "/api/seller/products", product([kofiImg]), ama);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("invalid_images");

    const kofiProduct = (await post(t.app, "/api/seller/products", product(), kofi)).json().product;
    const amaProduct = (await post(t.app, "/api/seller/products", product(), ama)).json().product;
    const steal = await send(t.app, "PUT", `/api/seller/products/${amaProduct.id}`, ama, product([], {
      variants: [{ id: kofiProduct.variants[0].id, size: "M", stock: 99 }],
    }));
    expect(steal.statusCode).toBe(400);
  });

  it("won't let a seller delete another seller's upload", async () => {
    const img = (await upload(t.app, kofi, await makeJpeg())).json().image.id;
    await send(t.app, "DELETE", `/api/seller/images/${img}`, ama);
    const ok = await post(t.app, "/api/seller/products", product([img]), kofi);
    expect(ok.statusCode).toBe(201);
  });
});

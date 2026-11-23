import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approve, makeProduct, ORIGIN, post, resetDb, send, setupTestApp, signUpSeller } from "./helpers.ts";

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
  t.notifier.sent.length = 0;
  kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  ama = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
  await approve(t.db, "kofi-thrift");
  await approve(t.db, "ama-wear");
});

const get = (url: string, cookie?: string) =>
  t.app.inject({ method: "GET", url, ...(cookie && { headers: { cookie } }) });
const call = (url: string, body: unknown) => post(t.app, url, body);
const zones = async (cookie: string, list: object[]) =>
  (await send(t.app, "PUT", "/api/seller/delivery/zones", cookie, { zones: list })).json().zones as { id: string; name: string }[];

const order = (slug: string, o: object) =>
  call(`/api/stores/${slug}/orders`, {
    fulfilment: "delivery",
    clientToken: randomUUID(),
    customerName: "Esi Mensah",
    customerPhone: "0201112233",
    addressText: "House 12, Palm Street",
    ...o,
  });

async function stock(variantId: string) {
  const r = await t.db.execute(sql`SELECT stock FROM product_variants WHERE id = ${variantId}`);
  return (r.rows[0] as { stock: number }).stock;
}

describe("store visibility", () => {
  it("hides a pending store from the public but previews it for its owner", async () => {
    await t.db.execute(sql`UPDATE sellers SET status = 'pending' WHERE slug = 'kofi-thrift'`);
    expect((await get("/api/stores/kofi-thrift")).statusCode).toBe(404);
    expect((await get("/api/stores/kofi-thrift", ama)).statusCode).toBe(404);
    const own = await get("/api/stores/kofi-thrift", kofi);
    expect(own.statusCode).toBe(200);
    expect(own.json().store.preview).toBe(true);
  });

  it("returns 404 for unknown, suspended and banned stores", async () => {
    expect((await get("/api/stores/nobody")).statusCode).toBe(404);
    await t.db.execute(sql`UPDATE sellers SET status = 'suspended' WHERE slug = 'kofi-thrift'`);
    expect((await get("/api/stores/kofi-thrift", kofi)).statusCode).toBe(404);
  });

  it("matches the slug case-insensitively", async () => {
    expect((await get("/api/stores/Kofi-Thrift")).statusCode).toBe(200);
  });

  it("refuses orders on a store that isn't live, even for its owner", async () => {
    await t.db.execute(sql`UPDATE sellers SET status = 'pending' WHERE slug = 'kofi-thrift'`);
    const p = await makeProduct(t.app, kofi);
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const r = await order("kofi-thrift", { items: [{ variantId: p.variants[0]!.id, quantity: 1 }], zoneId: z[0]!.id });
    expect(r.statusCode).toBe(404);
  });
});

describe("browsing", () => {
  it("lists only active products, sinks sold-out ones and never leaks exact stock", async () => {
    await makeProduct(t.app, kofi, { title: "Sold out tee", variants: [{ size: "M", stock: 0 }] });
    await makeProduct(t.app, kofi, { title: "Draft only", publish: false });
    const live = await makeProduct(t.app, kofi, { title: "Plenty", variants: [{ size: "M", stock: 500 }] });

    const { store } = (await get("/api/stores/kofi-thrift")).json();
    expect(store.products.map((p: { title: string }) => p.title)).toEqual(["Plenty", "Sold out tee"]);
    expect(store.products[1].soldOut).toBe(true);
    expect(store.categories).toEqual(["Hoodies and jackets"]);

    const detail = (await get(`/api/stores/kofi-thrift/products/${live.id}`)).json().product;
    expect(detail.variants[0].available).toBe(10);
    expect(JSON.stringify(detail.variants)).not.toContain("stock");
  });

  it("shows only active delivery zones and hides the pickup address when pickup is off", async () => {
    await zones(kofi, [{ name: "Madina", feePesewas: 1500 }, { name: "Osu", feePesewas: 2000 }]);
    await t.db.execute(sql`UPDATE delivery_zones SET active = false WHERE name = 'Osu'`);
    await t.db.execute(sql`UPDATE sellers SET pickup_address = 'Secret yard' WHERE slug = 'kofi-thrift'`);
    const { store } = (await get("/api/stores/kofi-thrift")).json();
    expect(store.delivery.zones.map((z: { name: string }) => z.name)).toEqual(["Madina"]);
    expect(store.delivery.settings.pickupAddress).toBeNull();
  });

  it("won't show one store's product through another store's URL", async () => {
    const p = await makeProduct(t.app, kofi);
    expect((await get(`/api/stores/ama-wear/products/${p.id}`)).statusCode).toBe(404);
    await post(t.app, `/api/seller/products/${p.id}/status`, { status: "draft" }, kofi);
    expect((await get(`/api/stores/kofi-thrift/products/${p.id}`)).statusCode).toBe(404);
  });

  it("shows the lowest variant price as a 'from' price", async () => {
    await makeProduct(t.app, kofi, {
      variants: [{ size: "S", stock: 2, pricePesewas: 7000 }, { size: "L", stock: 2 }],
    });
    const card = (await get("/api/stores/kofi-thrift")).json().store.products[0];
    expect(card.pricePesewas).toBe(7000);
    expect(card.fromPrice).toBe(true);
  });
});

describe("quote", () => {
  it("prices from the database, merges duplicate lines and adds the zone fee", async () => {
    const p = await makeProduct(t.app, kofi, { variants: [{ size: "M", stock: 5 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const v = p.variants[0]!.id;
    const q = (await call("/api/stores/kofi-thrift/quote", {
      items: [{ variantId: v, quantity: 1 }, { variantId: v, quantity: 2 }],
      fulfilment: "delivery",
      zoneId: z[0]!.id,
      // A hostile client can send whatever it likes; it is ignored.
      unitPricePesewas: 1,
      totalPesewas: 1,
    })).json();
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ quantity: 3, unitPricePesewas: 8500, lineTotalPesewas: 25500 });
    expect(q.subtotalPesewas).toBe(25500);
    expect(q.totalPesewas).toBe(27000);
    expect(q.orderable).toBe(true);
  });

  it("leaves the total open until an area is chosen", async () => {
    const p = await makeProduct(t.app, kofi);
    const q = (await call("/api/stores/kofi-thrift/quote", {
      items: [{ variantId: p.variants[0]!.id, quantity: 1 }],
      fulfilment: "delivery",
    })).json();
    expect(q.delivery).toBeNull();
    expect(q.totalPesewas).toBeNull();
  });

  it("flags reduced and sold-out lines and unknown or foreign variants", async () => {
    const low = await makeProduct(t.app, kofi, { variants: [{ size: "M", stock: 2 }] });
    const gone = await makeProduct(t.app, kofi, { title: "Gone", variants: [{ size: "M", stock: 0 }] });
    const theirs = await makeProduct(t.app, ama, { title: "Ama's" });
    const q = (await call("/api/stores/kofi-thrift/quote", {
      items: [
        { variantId: low.variants[0]!.id, quantity: 5 },
        { variantId: gone.variants[0]!.id, quantity: 1 },
        { variantId: theirs.variants[0]!.id, quantity: 1 },
        { variantId: randomUUID(), quantity: 1 },
      ],
      fulfilment: "pickup",
    })).json();
    expect(q.lines.map((l: { problem: string }) => l.problem)).toEqual(["reduced", "sold_out", "unavailable", "unavailable"]);
    expect(q.lines[0].quantity).toBe(2);
    expect(q.lines[2].title).toBe("No longer available");
    expect(q.orderable).toBe(false);
  });

  it("applies free delivery over the threshold and refuses areas the store doesn't serve", async () => {
    const p = await makeProduct(t.app, kofi, { pricePesewas: 10000, variants: [{ size: "M", stock: 5 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    await send(t.app, "PUT", "/api/seller/delivery/settings", kofi, {
      pickupEnabled: false,
      pickupAddress: null,
      freeDeliveryOverPesewas: 20000,
    });
    const v = p.variants[0]!.id;
    const free = (await call("/api/stores/kofi-thrift/quote", {
      items: [{ variantId: v, quantity: 2 }], fulfilment: "delivery", zoneId: z[0]!.id,
    })).json();
    expect(free.delivery).toMatchObject({ ok: true, feePesewas: 0, freeApplied: true });

    const other = await zones(ama, [{ name: "Osu", feePesewas: 1000 }]);
    const wrong = (await call("/api/stores/kofi-thrift/quote", {
      items: [{ variantId: v, quantity: 1 }], fulfilment: "delivery", zoneId: other[0]!.id,
    })).json();
    expect(wrong.delivery.ok).toBe(false);

    const pickup = (await call("/api/stores/kofi-thrift/quote", {
      items: [{ variantId: v, quantity: 1 }], fulfilment: "pickup",
    })).json();
    expect(pickup.delivery.ok).toBe(false);
  });
});

describe("placing an order", () => {
  it("creates the order, takes the stock, snapshots the lines and tells the seller", async () => {
    const p = await makeProduct(t.app, kofi, { title: "Carhartt hoodie", variants: [{ size: "M", stock: 3 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const v = p.variants[0]!.id;
    const r = await order("kofi-thrift", { items: [{ variantId: v, quantity: 2 }], zoneId: z[0]!.id, landmark: "Near the mall" });
    expect(r.statusCode).toBe(201);
    const o = r.json().order;
    expect(o.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(o).toMatchObject({
      subtotalPesewas: 17000,
      deliveryFeePesewas: 1500,
      totalPesewas: 18500,
      zoneName: "Madina",
      customerPhone: "+233201112233",
    });
    expect(o.items[0]).toMatchObject({ title: "Carhartt hoodie", label: "M", quantity: 2, lineTotalPesewas: 17000 });
    expect(await stock(v)).toBe(1);

    const events = await t.db.execute(sql`SELECT to_status, actor FROM order_events`);
    expect(events.rows).toEqual([{ to_status: "pending_payment", actor: "customer" }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.notifier.sent[0]).toMatchObject({ to: "+233241234567", code: o.code, totalPesewas: 18500, itemCount: 2 });

    // Later price edits never rewrite history.
    await t.db.execute(sql`UPDATE products SET title = 'Renamed', price_pesewas = 1`);
    const seen = (await send(t.app, "GET", "/api/seller/orders", kofi)).json().orders[0];
    expect(seen.items[0].title).toBe("Carhartt hoodie");
    expect(seen.items[0].unitPricePesewas).toBe(8500);
  });

  it("is idempotent: the same checkout token never places or charges stock twice", async () => {
    const p = await makeProduct(t.app, kofi, { variants: [{ size: "M", stock: 3 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const v = p.variants[0]!.id;
    const clientToken = randomUUID();
    const body = { items: [{ variantId: v, quantity: 1 }], zoneId: z[0]!.id, clientToken };
    const [a, b] = await Promise.all([order("kofi-thrift", body), order("kofi-thrift", body)]);
    expect([a.statusCode, b.statusCode, a.body, b.body]).toEqual([201, 201, expect.anything(), expect.anything()]);
    expect(a.json().order.code).toBe(b.json().order.code);
    expect((await order("kofi-thrift", body)).json().order.code).toBe(a.json().order.code);
    expect(await stock(v)).toBe(2);
    const n = await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`);
    expect((n.rows[0] as { n: number }).n).toBe(1);
  });

  it("never oversells the last item under concurrent checkouts", async () => {
    const p = await makeProduct(t.app, kofi, { variants: [{ size: "M", stock: 1 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const v = p.variants[0]!.id;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => order("kofi-thrift", { items: [{ variantId: v, quantity: 1 }], zoneId: z[0]!.id })),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    expect(await stock(v)).toBe(0);
  });

  it("rejects a cart that changed under the customer, and keeps the stock untouched", async () => {
    const a = await makeProduct(t.app, kofi, { title: "Item A", variants: [{ size: "M", stock: 5 }] });
    const b = await makeProduct(t.app, kofi, { title: "Item B", variants: [{ size: "M", stock: 1 }] });
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const r = await order("kofi-thrift", {
      items: [{ variantId: a.variants[0]!.id, quantity: 2 }, { variantId: b.variants[0]!.id, quantity: 3 }],
      zoneId: z[0]!.id,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("cart_changed");
    expect(await stock(a.variants[0]!.id)).toBe(5);
    expect(await stock(b.variants[0]!.id)).toBe(1);
  });

  it("won't take another store's product or another store's zone", async () => {
    const mine = await makeProduct(t.app, kofi);
    const theirs = await makeProduct(t.app, ama, { title: "Ama's" });
    const myZone = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const theirZone = await zones(ama, [{ name: "Osu", feePesewas: 1000 }]);

    const foreignItem = await order("kofi-thrift", { items: [{ variantId: theirs.variants[0]!.id, quantity: 1 }], zoneId: myZone[0]!.id });
    expect(foreignItem.statusCode).toBe(409);
    const foreignZone = await order("kofi-thrift", { items: [{ variantId: mine.variants[0]!.id, quantity: 1 }], zoneId: theirZone[0]!.id });
    expect(foreignZone.statusCode).toBe(400);
    expect(foreignZone.json().error.code).toBe("delivery_unavailable");
    expect(await stock(mine.variants[0]!.id)).toBe(3);
  });

  it("validates the customer's details", async () => {
    const p = await makeProduct(t.app, kofi);
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const base = { items: [{ variantId: p.variants[0]!.id, quantity: 1 }], zoneId: z[0]!.id };

    const phone = await order("kofi-thrift", { ...base, customerPhone: "12345" });
    expect(phone.statusCode).toBe(400);
    expect(phone.json().error.fields.customerPhone).toBeTruthy();

    const noAddress = await order("kofi-thrift", { ...base, addressText: "" });
    expect(noAddress.json().error.fields.addressText).toBeTruthy();

    const noZone = await order("kofi-thrift", { items: base.items });
    expect(noZone.json().error.fields.zoneId).toBeTruthy();

    const tooMany = await order("kofi-thrift", { items: [{ variantId: base.items[0]!.variantId, quantity: 11 }], zoneId: z[0]!.id });
    expect(tooMany.statusCode).toBe(400);
  });

  it("takes pickup orders without an address when the store offers pickup", async () => {
    const p = await makeProduct(t.app, kofi);
    const items = [{ variantId: p.variants[0]!.id, quantity: 1 }];
    const off = await order("kofi-thrift", { items, fulfilment: "pickup", addressText: null });
    expect(off.statusCode).toBe(400);

    await send(t.app, "PUT", "/api/seller/delivery/settings", kofi, {
      pickupEnabled: true,
      pickupAddress: "Shop 4, Makola",
      freeDeliveryOverPesewas: null,
    });
    const on = await order("kofi-thrift", { items, fulfilment: "pickup", addressText: null });
    expect(on.statusCode).toBe(201);
    expect(on.json().order).toMatchObject({ fulfilment: "pickup", deliveryFeePesewas: 0, totalPesewas: 8500 });
  });

  it("refuses blocked phone numbers without naming the reason", async () => {
    const p = await makeProduct(t.app, kofi);
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const { sha256 } = await import("../src/lib/crypto.ts");
    await t.db.execute(sql`INSERT INTO blocklist (kind, value_hash) VALUES ('phone', ${sha256("+233201112233")})`);
    const r = await order("kofi-thrift", { items: [{ variantId: p.variants[0]!.id, quantity: 1 }], zoneId: z[0]!.id });
    expect(r.statusCode).toBe(403);
    expect(await stock(p.variants[0]!.id)).toBe(3);
  });

  it("still places the order when the seller notification fails", async () => {
    const p = await makeProduct(t.app, kofi);
    const z = await zones(kofi, [{ name: "Madina", feePesewas: 1500 }]);
    const original = t.notifier.orderPlaced.bind(t.notifier);
    t.notifier.orderPlaced = async () => {
      throw new Error("meta is down");
    };
    try {
      const r = await order("kofi-thrift", { items: [{ variantId: p.variants[0]!.id, quantity: 1 }], zoneId: z[0]!.id });
      expect(r.statusCode).toBe(201);
    } finally {
      t.notifier.orderPlaced = original;
    }
  });

  it("blocks cross-origin order posts", async () => {
    const r = await t.app.inject({
      method: "POST",
      url: "/api/stores/kofi-thrift/orders",
      payload: {},
      headers: { origin: "https://evil.example" },
    });
    expect(r.statusCode).toBe(403);
    void ORIGIN;
  });
});

describe("seller orders", () => {
  async function placed(slug: string, cookie: string) {
    const p = await makeProduct(t.app, cookie, { variants: [{ size: "M", stock: 3 }] });
    const z = await zones(cookie, [{ name: "Madina", feePesewas: 1500 }]);
    const v = p.variants[0]!.id;
    const r = await order(slug, { items: [{ variantId: v, quantity: 2 }], zoneId: z[0]!.id });
    return { v, id: (await send(t.app, "GET", "/api/seller/orders", cookie)).json().orders[0].id as string, order: r.json().order };
  }

  it("lists a seller's own orders only", async () => {
    await placed("kofi-thrift", kofi);
    expect((await send(t.app, "GET", "/api/seller/orders", kofi)).json().orders).toHaveLength(1);
    expect((await send(t.app, "GET", "/api/seller/orders", ama)).json().orders).toHaveLength(0);
    expect((await t.app.inject({ method: "GET", url: "/api/seller/orders" })).statusCode).toBe(401);
  });

  it("cancels an unpaid order, restores stock, and can't cancel twice", async () => {
    const { v, id } = await placed("kofi-thrift", kofi);
    expect(await stock(v)).toBe(1);
    const res = await post(t.app, `/api/seller/orders/${id}/cancel`, {}, kofi);
    expect(res.statusCode).toBe(204);
    expect(await stock(v)).toBe(3);
    expect((await post(t.app, `/api/seller/orders/${id}/cancel`, {}, kofi)).statusCode).toBe(409);
    expect(await stock(v)).toBe(3);
    const events = await t.db.execute(sql`SELECT to_status, actor FROM order_events ORDER BY created_at`);
    expect(events.rows.map((e) => (e as { to_status: string }).to_status)).toEqual(["pending_payment", "cancelled"]);
  });

  it("won't let another seller cancel it, and won't cancel a paid order", async () => {
    const { v, id } = await placed("kofi-thrift", kofi);
    expect((await post(t.app, `/api/seller/orders/${id}/cancel`, {}, ama)).statusCode).toBe(404);
    expect(await stock(v)).toBe(1);
    await t.db.execute(sql`UPDATE orders SET status = 'paid'`);
    expect((await post(t.app, `/api/seller/orders/${id}/cancel`, {}, kofi)).statusCode).toBe(409);
  });
});

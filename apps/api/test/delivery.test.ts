import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, send, setupTestApp, signUpSeller } from "./helpers.ts";

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
  kofi = await signUpSeller(t.app, t.sender, "0241234567", "kofi-thrift");
  ama = await signUpSeller(t.app, t.sender, "0551234567", "ama-wear");
});

const put = (cookie: string, zones: object[]) => send(t.app, "PUT", "/api/seller/delivery/zones", cookie, { zones });

describe("delivery zones", () => {
  it("replaces the list, keeping ids, order and allowing renames that swap", async () => {
    const first = (await put(kofi, [
      { name: "Madina", feePesewas: 1500 },
      { name: "East Legon", feePesewas: 2500, etaLabel: "Same day" },
    ])).json().zones;
    expect(first.map((z: { name: string }) => z.name)).toEqual(["Madina", "East Legon"]);

    const [madina, legon] = first;
    const second = (await put(kofi, [
      { id: legon.id, name: "Madina", feePesewas: 2500 },
      { id: madina.id, name: "East Legon", feePesewas: 1500 },
      { name: "Kasoa", feePesewas: 3500 },
    ])).json().zones;
    expect(second.map((z: { id: string; name: string }) => [z.id, z.name])).toEqual([
      [legon.id, "Madina"],
      [madina.id, "East Legon"],
      [second[2].id, "Kasoa"],
    ]);

    const third = (await put(kofi, [{ id: madina.id, name: "East Legon", feePesewas: 1500 }])).json().zones;
    expect(third).toHaveLength(1);
  });

  it("rejects duplicates and negative fees", async () => {
    const dup = await put(kofi, [{ name: "Madina", feePesewas: 1500 }, { name: "MADINA", feePesewas: 1000 }]);
    expect(dup.statusCode).toBe(400);
    const neg = await put(kofi, [{ name: "Osu", feePesewas: -1 }]);
    expect(neg.statusCode).toBe(400);
  });

  it("keeps sellers' zones separate", async () => {
    const kofiZones = (await put(kofi, [{ name: "Madina", feePesewas: 1500 }])).json().zones;
    const hijack = await put(ama, [{ id: kofiZones[0].id, name: "Madina", feePesewas: 0 }]);
    expect(hijack.statusCode).toBe(400);
    expect((await send(t.app, "GET", "/api/seller/delivery", ama)).json().zones).toEqual([]);
    expect((await send(t.app, "GET", "/api/seller/delivery", kofi)).json().zones[0].feePesewas).toBe(1500);
  });

  it("saves pickup and free-delivery settings", async () => {
    const missing = await send(t.app, "PUT", "/api/seller/delivery/settings", kofi, {
      pickupEnabled: true, pickupAddress: "", freeDeliveryOverPesewas: null,
    });
    expect(missing.json().error.fields.pickupAddress).toBeTruthy();

    const ok = await send(t.app, "PUT", "/api/seller/delivery/settings", kofi, {
      pickupEnabled: true, pickupAddress: "Madina Zongo Junction, opposite Total", freeDeliveryOverPesewas: 50000,
    });
    expect(ok.json().settings).toEqual({
      pickupEnabled: true, pickupAddress: "Madina Zongo Junction, opposite Total", freeDeliveryOverPesewas: 50000,
    });
  });
});

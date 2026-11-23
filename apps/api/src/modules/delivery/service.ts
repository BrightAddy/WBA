import { asc, eq, inArray, sql } from "drizzle-orm";
import type { deliverySettingsSchema, DeliveryConfigDto, zonesInputSchema } from "@kiosk/shared";
import type { z } from "zod";
import type { Db } from "../../db/client.ts";
import { deliveryZones, sellers } from "../../db/schema.ts";
import { badRequest } from "../../lib/errors.ts";

type ZonesInput = z.output<typeof zonesInputSchema>["zones"];
type SettingsInput = z.output<typeof deliverySettingsSchema>;

export function createDeliveryService({ db }: { db: Db }) {
  async function getConfig(sellerId: string): Promise<DeliveryConfigDto> {
    const [zones, [seller]] = await Promise.all([
      db.select().from(deliveryZones).where(eq(deliveryZones.sellerId, sellerId)).orderBy(asc(deliveryZones.position)),
      db
        .select({
          pickupEnabled: sellers.pickupEnabled,
          pickupAddress: sellers.pickupAddress,
          freeDeliveryOverPesewas: sellers.freeDeliveryOverPesewas,
        })
        .from(sellers)
        .where(eq(sellers.id, sellerId)),
    ]);
    return {
      zones: zones.map((z) => ({ id: z.id, name: z.name, feePesewas: z.feePesewas, etaLabel: z.etaLabel })),
      settings: seller!,
    };
  }

  /** Replace the whole zone list atomically, keeping ids for zones that still exist. */
  async function replaceZones(sellerId: string, zones: ZonesInput) {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: deliveryZones.id })
        .from(deliveryZones)
        .where(eq(deliveryZones.sellerId, sellerId))
        .for("update");
      const existingIds = new Set(existing.map((z) => z.id));
      const keepIds = zones.flatMap((z) => (z.id ? [z.id] : []));
      if (keepIds.some((id) => !existingIds.has(id))) {
        throw badRequest("invalid_zones", "An area was changed elsewhere. Reload and try again.");
      }

      const remove = [...existingIds].filter((id) => !keepIds.includes(id));
      if (remove.length) await tx.delete(deliveryZones).where(inArray(deliveryZones.id, remove));
      if (keepIds.length) {
        // Placeholder names first, so renames like A<->B don't hit the unique index.
        await tx
          .update(deliveryZones)
          .set({ name: sql`'__' || ${deliveryZones.id}::text` })
          .where(inArray(deliveryZones.id, keepIds));
      }
      for (const [position, z] of zones.entries()) {
        const row = { name: z.name, feePesewas: z.feePesewas, etaLabel: z.etaLabel, position };
        if (z.id) await tx.update(deliveryZones).set(row).where(eq(deliveryZones.id, z.id));
        else await tx.insert(deliveryZones).values({ ...row, sellerId });
      }
    });
    return getConfig(sellerId);
  }

  async function updateSettings(sellerId: string, s: SettingsInput) {
    await db
      .update(sellers)
      .set({
        pickupEnabled: s.pickupEnabled,
        pickupAddress: s.pickupAddress,
        freeDeliveryOverPesewas: s.freeDeliveryOverPesewas,
      })
      .where(eq(sellers.id, sellerId));
    return getConfig(sellerId);
  }

  return { getConfig, replaceZones, updateSettings };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;

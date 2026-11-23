import { desc, eq, and, inArray, sql } from "drizzle-orm";
import type { SellerOrderDto } from "@kiosk/shared";
import type { Db } from "../../db/client.ts";
import { orderEvents, orderItems, orders, productVariants, sellers } from "../../db/schema.ts";
import { AppError } from "../../lib/errors.ts";
import { placedView } from "../store/service.ts";

export function createOrdersService({ db }: { db: Db }) {
  async function list(sellerId: string, limit = 100): Promise<SellerOrderDto[]> {
    const [seller] = await db.select({ name: sellers.storeName }).from(sellers).where(eq(sellers.id, sellerId));
    const rows = await db.select().from(orders).where(eq(orders.sellerId, sellerId)).orderBy(desc(orders.createdAt)).limit(limit);
    if (!rows.length) return [];
    const items = await db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, rows.map((r) => r.id)));
    return rows.map((o) => ({
      ...placedView(o, items.filter((i) => i.orderId === o.id), seller!.name),
      id: o.id,
      status: o.status,
      addressText: o.addressText,
      landmark: o.landmark,
      note: o.note,
      channel: o.channel,
    }));
  }

  /**
   * Cancels an order that hasn't been paid and puts its stock back. Paid orders
   * are cancelled through refunds (Day 5), never silently here.
   */
  async function cancelUnpaid(sellerId: string, orderId: string, actorAccountId: string) {
    await db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.sellerId, sellerId)))
        .for("update");
      if (!o) throw new AppError(404, "not_found", "That order doesn't exist.");
      if (o.status !== "pending_payment") {
        throw new AppError(409, "not_cancellable", "Only orders waiting for payment can be cancelled here.");
      }
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
      for (const i of items) {
        if (!i.variantId) continue; // variant was deleted since; nothing to restore
        await tx
          .update(productVariants)
          .set({ stock: sql`${productVariants.stock} + ${i.quantity}` })
          .where(eq(productVariants.id, i.variantId));
      }
      await tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, o.id));
      await tx.insert(orderEvents).values({
        orderId: o.id,
        fromStatus: "pending_payment",
        toStatus: "cancelled",
        actor: "seller",
        actorAccountId,
        note: "Cancelled by the seller before payment",
      });
    });
  }

  return { list, cancelUnpaid };
}

export type OrdersService = ReturnType<typeof createOrdersService>;

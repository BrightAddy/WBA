import { desc, eq, inArray, sql } from "drizzle-orm";
import type { AdminSellerDto, AdminSellerFilter } from "@kiosk/shared";
import type { Db } from "../../db/client.ts";
import { accounts, auditLog, deliveryZones, orders, products, sellers } from "../../db/schema.ts";
import { AppError, conflict } from "../../lib/errors.ts";

const FILTER_STATUSES: Record<AdminSellerFilter, ("pending" | "approved" | "suspended" | "banned")[]> = {
  pending: ["pending"],
  approved: ["approved"],
  suspended: ["suspended", "banned"],
};

export function createAdminService({ db }: { db: Db }) {
  async function counts(): Promise<Record<AdminSellerFilter, number>> {
    const rows = await db.select({ status: sellers.status, n: sql<number>`count(*)::int` }).from(sellers).groupBy(sellers.status);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
    return {
      pending: by.pending ?? 0,
      approved: by.approved ?? 0,
      suspended: (by.suspended ?? 0) + (by.banned ?? 0),
    };
  }

  async function listSellers(filter: AdminSellerFilter): Promise<AdminSellerDto[]> {
    const rows = await db
      .select({
        s: sellers,
        phone: accounts.phone,
        liveProducts: sql<number>`(SELECT count(*)::int FROM ${products} WHERE ${products.sellerId} = ${sellers.id} AND ${products.status} = 'active')`,
        deliveryAreas: sql<number>`(SELECT count(*)::int FROM ${deliveryZones} WHERE ${deliveryZones.sellerId} = ${sellers.id})`,
        orders: sql<number>`(SELECT count(*)::int FROM ${orders} WHERE ${orders.sellerId} = ${sellers.id})`,
      })
      .from(sellers)
      .innerJoin(accounts, eq(accounts.id, sellers.accountId))
      .where(inArray(sellers.status, FILTER_STATUSES[filter]))
      // Longest-waiting first, so nobody sits in review.
      .orderBy(filter === "pending" ? sellers.createdAt : desc(sellers.updatedAt));
    return rows.map(({ s, phone, ...n }) => ({
      id: s.id,
      storeName: s.storeName,
      slug: s.slug,
      ownerName: s.ownerName,
      phone,
      instagramUrl: s.instagramUrl,
      tiktokUrl: s.tiktokUrl,
      status: s.status,
      suspendedReason: s.suspendedReason,
      createdAt: s.createdAt.toISOString(),
      approvedAt: s.approvedAt?.toISOString() ?? null,
      ...n,
    }));
  }

  async function decide(
    adminId: string,
    sellerId: string,
    action: "approve" | "suspend",
    reason?: string,
  ) {
    await db.transaction(async (tx) => {
      const [s] = await tx.select().from(sellers).where(eq(sellers.id, sellerId)).for("update");
      if (!s) throw new AppError(404, "not_found", "That seller doesn't exist.");
      if (s.status === "banned") throw conflict("banned", "Banned sellers can't be changed here.");

      if (action === "approve") {
        if (s.status === "approved") throw conflict("already_approved", "This store is already live.");
        await tx
          .update(sellers)
          .set({ status: "approved", approvedAt: new Date(), approvedBy: adminId, suspendedReason: null })
          .where(eq(sellers.id, sellerId));
      } else {
        if (s.status === "suspended") throw conflict("already_suspended", "This store is already suspended.");
        await tx.update(sellers).set({ status: "suspended", suspendedReason: reason ?? null }).where(eq(sellers.id, sellerId));
      }
      await tx.insert(auditLog).values({
        actorAccountId: adminId,
        action: `seller.${action}`,
        entity: "seller",
        entityId: sellerId,
        data: { from: s.status, ...(reason && { reason }) },
      });
    });
  }

  return { counts, listSellers, decide };
}

export type AdminService = ReturnType<typeof createAdminService>;

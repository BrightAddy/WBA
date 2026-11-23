import { z } from "zod";

export type AdminSellerDto = {
  id: string;
  storeName: string;
  slug: string;
  ownerName: string;
  phone: string;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  status: "pending" | "approved" | "suspended" | "banned";
  suspendedReason: string | null;
  createdAt: string;
  approvedAt: string | null;
  liveProducts: number;
  deliveryAreas: number;
  orders: number;
};

export const suspendSchema = z.object({
  reason: z.string().trim().min(3, "Say why, so there's a record.").max(300),
});

export type AdminSellerFilter = "pending" | "approved" | "suspended";

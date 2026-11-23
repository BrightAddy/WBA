DROP INDEX "variants_product_idx";--> statement-breakpoint
ALTER TABLE "product_images" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "seller_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "position" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "images_seller_unattached_idx" ON "product_images" USING btree ("seller_id","created_at") WHERE "product_images"."product_id" IS NULL;--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id","position");
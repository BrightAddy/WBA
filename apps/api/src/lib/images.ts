import sharp, { type Metadata } from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { IMAGE_WIDTHS } from "@kiosk/shared";
import { badRequest } from "./errors.ts";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const ACCEPTED = new Set(["jpeg", "png", "webp", "heif", "avif", "gif"]);

export type ProcessedImage = {
  width: number;
  height: number;
  thumbhash: string;
  renditions: { width: number; body: Buffer }[];
};

/**
 * Decode, auto-rotate from EXIF, then re-encode. Re-encoding drops all
 * metadata, which matters: phone photos carry GPS coordinates, and a seller
 * working from home would otherwise publish their address on every product.
 */
export async function processProductImage(input: Buffer): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw badRequest("invalid_image", "That file isn't a photo we can read.");
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) {
    throw badRequest("invalid_image", "Upload a JPG, PNG, WebP or HEIC photo.");
  }

  const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).rotate();
  const { width, height } = await base.clone().toBuffer({ resolveWithObject: true }).then((r) => r.info);
  if (width < 200 || height < 200) {
    throw badRequest("image_too_small", "That photo is too small. Use one at least 200 pixels wide.");
  }

  const targets = [...new Set(IMAGE_WIDTHS.map((w) => Math.min(w, width)))];
  const renditions = await Promise.all(
    targets.map(async (w) => ({
      width: w,
      body: await base
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: w <= 320 ? 72 : 80, effort: 4, smartSubsample: true })
        .toBuffer(),
    })),
  );

  const small = await base
    .clone()
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(small.info.width, small.info.height, small.data);

  return { width, height, thumbhash: Buffer.from(hash).toString("base64"), renditions };
}

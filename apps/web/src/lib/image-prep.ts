/**
 * Shrink photos on the phone before upload. A 12 MP shot is 4-6 MB; at
 * 2000px JPEG q0.86 it's ~500 KB, which matters on prepaid mobile data.
 * The server re-encodes anyway, so this only has to be good, not perfect.
 */
const MAX_EDGE = 2000;
const SKIP_BELOW_BYTES = 900_000;

export async function prepareImage(file: File): Promise<Blob> {
  if (file.size < SKIP_BELOW_BYTES && /^image\/(jpeg|webp)$/.test(file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // Format the browser can't decode (e.g. HEIC on Android): let the server decide.
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob =
    canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86))
      : await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
  return blob && blob.size < file.size ? blob : file;
}

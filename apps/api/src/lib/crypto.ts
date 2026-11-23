import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Uniform 6-digit code; randomInt is unbiased, unlike Math.random()*10^6. */
export const generateOtp = () => randomInt(0, 1_000_000).toString().padStart(6, "0");

/**
 * Bind the code to its challenge id so a leaked hash can't be replayed against
 * another challenge, and key it with a server secret so the 10^6 code space
 * can't be brute-forced offline from a DB dump.
 */
export const hashOtp = (secret: string, challengeId: string, code: string) =>
  createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const generateSessionToken = () => randomBytes(32).toString("base64url");
export const sha256 = (v: string) => createHash("sha256").update(v).digest("base64url");

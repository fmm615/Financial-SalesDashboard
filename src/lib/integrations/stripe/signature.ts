import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

function signatures(header: string): { timestamp: number; signatures: string[] } | null {
  const parts = header.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  if (!timestampPart) return null;
  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isSafeInteger(timestamp)) return null;
  return { timestamp, signatures: parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3)).filter(Boolean) };
}

/** Verifies Stripe's signed raw payload and rejects replayed events. */
export function isValidStripeSignature(input: { payload: string; signature: string | null; webhookSecret: string; now?: number }): boolean {
  if (!input.signature) return false;
  const parsed = signatures(input.signature);
  if (!parsed || !parsed.signatures.length || Math.abs(Math.floor((input.now ?? Date.now()) / 1000) - parsed.timestamp) > MAX_WEBHOOK_AGE_SECONDS) return false;
  const expected = createHmac("sha256", input.webhookSecret).update(`${parsed.timestamp}.${input.payload}`, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return parsed.signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const receivedBuffer = Buffer.from(signature, "hex");
    return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
  });
}

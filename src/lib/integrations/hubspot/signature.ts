import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

function decodeHubSpotUrl(url: string): string {
  return url.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (value) => decodeURIComponent(value));
}

/** Validates HubSpot's current v3 HMAC signature and replay window. */
export function isValidHubSpotSignature(input: {
  clientSecret: string;
  method: string;
  url: string;
  body: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
}): boolean {
  if (!input.signature || !input.timestamp || !/^\d+$/.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs((input.now ?? Date.now()) - timestamp) > MAX_WEBHOOK_AGE_MS) return false;

  const expected = createHmac("sha256", input.clientSecret)
    .update(`${input.method.toUpperCase()}${decodeHubSpotUrl(input.url)}${input.body}${input.timestamp}`, "utf8")
    .digest("base64");
  const received = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

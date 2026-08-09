import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const currencyFractionDigits: Record<string, number> = {
  BHD: 3, JOD: 3, KWD: 3, OMR: 3,
};

const tapWebhookSchema = z.object({
  id: z.string().min(1),
  amount: z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)]),
  currency: z.string().length(3),
  status: z.string().min(1),
  reference: z.object({ gateway: z.string().nullable().optional(), payment: z.union([z.string(), z.number()]).nullable().optional() }).nullable().optional(),
  transaction: z.object({ created: z.union([z.string(), z.number()]) }).nullable().optional(),
  created: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();

function formattedTapAmount(value: string | number, currency: string): string | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return numberValue.toFixed(currencyFractionDigits[currency] ?? 2);
}

/** Validates Tap's documented hashstring against the parsed posted charge. */
export function isValidTapWebhookSignature(input: { payload: unknown; signature: string | null; secretApiKey: string }): boolean {
  if (!input.signature || !/^[a-f0-9]{64}$/i.test(input.signature)) return false;
  const parsed = tapWebhookSchema.safeParse(input.payload);
  if (!parsed.success) return false;
  const charge = parsed.data;
  const currency = charge.currency.toUpperCase();
  const amount = formattedTapAmount(charge.amount, currency);
  const created = charge.transaction?.created ?? charge.created;
  if (!amount || created === null || created === undefined) return false;
  const gatewayReference = charge.reference?.gateway ?? "";
  const paymentReference = charge.reference?.payment === null || charge.reference?.payment === undefined ? "" : String(charge.reference.payment);
  const signed = `x_id${charge.id}x_amount${amount}x_currency${currency}x_gateway_reference${gatewayReference}x_payment_reference${paymentReference}x_status${charge.status}x_created${created}`;
  const expected = createHmac("sha256", input.secretApiKey).update(signed, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(input.signature, "hex");
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

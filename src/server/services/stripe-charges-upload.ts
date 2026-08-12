import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "@/lib/supabase/server";
import { STRIPE_CHARGES_MIME_TYPE, STRIPE_CHARGES_STORAGE_BUCKET } from "@/lib/validation/stripe-charges-upload-contracts";
import { parseStripeChargesCsv, type ParsedStripeCharges } from "@/server/services/stripe-charges-csv";
import type { Json } from "@/types/database.generated";

export class StripeChargesUploadError extends Error {}

export type StripeChargesPreview = {
  sourceFileSha256: string;
  sourceRows: number;
  evidenceEntries: number;
  saleEntries: number;
  refundEntries: number;
  needsReviewEntries: number;
  rowsWithContact: number;
  nonUsdSaleEntries: number;
};

async function readStripeChargesFile(file: File): Promise<ParsedStripeCharges> {
  return parseStripeChargesCsv(file.name, new Uint8Array(await file.arrayBuffer()));
}

function buildPreview(charges: ParsedStripeCharges): StripeChargesPreview {
  const primaryRows = charges.rows.filter((entry) => entry.sourceEntryKey === "primary");
  return {
    sourceFileSha256: charges.sourceFileSha256,
    sourceRows: primaryRows.length,
    evidenceEntries: charges.rows.length,
    saleEntries: charges.rows.filter((entry) => entry.kind === "sale").length,
    refundEntries: charges.rows.filter((entry) => entry.kind === "refund").length,
    needsReviewEntries: charges.rows.filter((entry) => entry.kind === "needs_review").length,
    rowsWithContact: primaryRows.filter((entry) => Boolean(entry.customerName || entry.customerEmail || entry.customerPhone)).length,
    nonUsdSaleEntries: charges.rows.filter((entry) => entry.kind === "sale" && entry.currency !== "USD").length,
  };
}

/** Parses a Stripe export in memory and returns safe evidence counts only. */
export async function previewStripeChargesUpload(file: File): Promise<StripeChargesPreview> {
  return buildPreview(await readStripeChargesFile(file));
}

/** Stores a confirmed original Stripe source and stages evidence atomically. */
export async function finalizeStripeChargesUpload(client: DatabaseClient, file: File, expectedFileSha256: string): Promise<string> {
  const charges = await readStripeChargesFile(file);
  if (charges.sourceFileSha256 !== expectedFileSha256) throw new StripeChargesUploadError("The selected file changed after its preview. Preview it again before staging.");
  const sourceStoragePath = `stripe-charges/${charges.sourceFileSha256}/${randomUUID()}.csv`;
  const storage = client.storage.from(STRIPE_CHARGES_STORAGE_BUCKET);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: storageError } = await storage.upload(sourceStoragePath, bytes, { contentType: STRIPE_CHARGES_MIME_TYPE, upsert: false });
  if (storageError) throw new StripeChargesUploadError("The original Stripe Charges file could not be stored privately.");
  try {
    const { data, error } = await client.rpc("finalize_stripe_charges_import", {
      p_source_file_name: charges.sourceFileName,
      p_source_file_sha256: charges.sourceFileSha256,
      p_source_storage_bucket: STRIPE_CHARGES_STORAGE_BUCKET,
      p_source_storage_path: sourceStoragePath,
      p_rows: charges.rows.map((entry) => ({
        sourceRowNumber: entry.sourceRowNumber,
        sourceEntryKey: entry.sourceEntryKey,
        chargeId: entry.chargeId ?? "",
        kind: entry.kind,
        description: entry.description ?? "",
        occurredAt: entry.occurredAt ?? "",
        occurredAtRaw: entry.occurredAtRaw ?? "",
        currency: entry.currency,
        credit: entry.credit ?? "",
        debit: entry.debit ?? "",
        customerName: entry.customerName ?? "",
        customerEmail: entry.customerEmail ?? "",
        customerPhone: entry.customerPhone ?? "",
        rawPayload: entry.rawPayload as Json,
      })) as Json,
    });
    if (error || !data) throw new Error("Stripe Charges finalization failed.");
    return data;
  } catch {
    await storage.remove([sourceStoragePath]).catch(() => undefined);
    throw new StripeChargesUploadError("The Stripe Charges file could not be staged. No reportable B2C revenue was created.");
  }
}

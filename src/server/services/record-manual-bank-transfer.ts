import { createHash } from "node:crypto";
import type { ManualBankTransferInput } from "@/lib/validation/financial-contracts";
import type { B2cPayment, B2cPaymentsRepository } from "@/server/repositories/b2c-payments-repository";

export type { B2cPayment };

/** The public request shape. `receivedAt` is an ISO timestamp with an explicit offset -- the bank's own transfer date/time, never invented from a bare date. */
export type ManualBankTransferRequest = ManualBankTransferInput;

/** Server-normalized values, ready to hash and to send to the repository. Never trusts a browser-supplied fingerprint, currency, or business date. */
export type PreparedManualBankTransfer = {
  bankReference: string;
  customerEmail: string;
  customerName: string;
  categoryCode: string;
  membershipTier: string | null;
  /** Canonicalized to exactly six decimal places. */
  amountUsd: string;
  /** The exact reviewed ISO timestamp string, unmodified -- used for hashing and as the RPC's raw source of truth. */
  receivedAtRaw: string;
  /** The Asia/Bahrain business date derived from `receivedAtRaw`. */
  occurredOn: string;
  reason: string;
};

export type ManualBankTransferMatchRecordKind = "provider_payment" | "finance_row";

export type ManualBankTransferMatch = {
  recordKind: ManualBankTransferMatchRecordKind;
  recordId: string;
  sourceLabel: string;
  occurredOn: string;
  amountUsd: string;
};

export type ManualBankTransferExactMatchReason = "bank_reference" | "finance_lineage";

export type ManualBankTransferDuplicateAssessment = {
  inputSha256: string;
  matchState: "clear" | "exact_existing" | "possible_duplicate";
  exactMatchHref: string | null;
  possibleMatches: ManualBankTransferMatch[];
  /** Which exact-match check fired, so the caller can produce a specific message. Not part of the minimal plan contract, but additive and safe to ignore. */
  exactMatchReason?: ManualBankTransferExactMatchReason | null;
};

function bahrainBusinessDate(occurredAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bahrain", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(occurredAt);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canonicalAmount(value: string): string {
  const [whole, fraction = ""] = value.trim().split(".");
  return `${whole.replace(/^0+(?=\d)/, "") || "0"}.${fraction.padEnd(6, "0").slice(0, 6)}`;
}

/** Normalizes the browser's request into server-owned values. The server -- never the browser -- derives the Bahrain business date and canonical amount. */
export function prepareManualBankTransfer(input: ManualBankTransferRequest): PreparedManualBankTransfer {
  return {
    bankReference: input.bankReference.trim(),
    customerEmail: input.customerEmail.trim().toLowerCase(),
    customerName: input.customerName.trim(),
    categoryCode: input.categoryCode.trim(),
    membershipTier: input.membershipTier?.trim() || null,
    amountUsd: canonicalAmount(input.amountUsd),
    receivedAtRaw: input.receivedAt.trim(),
    occurredOn: bahrainBusinessDate(new Date(input.receivedAt)),
    reason: input.reason.trim(),
  };
}

/**
 * Hashes exactly the fields the Admin reviewed at Step 2. Preview computes
 * this once; confirmation recomputes it from the submitted values and the
 * database RPC verifies it again -- a changed field between preview and
 * confirmation always fails this check before any write is attempted.
 */
export function hashPreparedManualBankTransfer(prepared: PreparedManualBankTransfer): string {
  const canonical = [
    prepared.bankReference,
    prepared.customerEmail,
    prepared.customerName,
    prepared.categoryCode,
    prepared.membershipTier ?? "",
    prepared.amountUsd,
    prepared.receivedAtRaw,
    prepared.reason,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Read-only, advisory duplicate assessment. Never writes; the confirm step reruns every check inside the protected transaction. */
export async function previewManualBankTransfer(
  input: ManualBankTransferRequest,
  repository: B2cPaymentsRepository,
): Promise<ManualBankTransferDuplicateAssessment> {
  const prepared = prepareManualBankTransfer(input);
  return repository.assessManualBankTransferDuplicates(prepared);
}

/**
 * Records a genuinely new manual bank transfer. Exact bank-reference and
 * exact Finance-lineage matches are rejected outright with a specific
 * message; a possible (48-hour content) match is not rejected here -- the
 * repository/RPC retains the payment and opens a blocking review flag in the
 * same atomic write.
 */
export async function recordManualBankTransfer(
  input: ManualBankTransferRequest & { expectedInputSha256: string },
  repository: B2cPaymentsRepository,
): Promise<B2cPayment> {
  const prepared = prepareManualBankTransfer(input);
  const computedHash = hashPreparedManualBankTransfer(prepared);
  if (computedHash !== input.expectedInputSha256) {
    throw new Error("The reviewed bank transfer details changed since preview. Review the current values and try again.");
  }

  const assessment = await repository.assessManualBankTransferDuplicates(prepared);
  if (assessment.matchState === "exact_existing") {
    throw new Error(
      assessment.exactMatchReason === "bank_reference"
        ? "A manual bank transfer with this reference already exists."
        : "This transfer already exists as a Payment Tracker record. Link the evidence instead of recording it again.",
    );
  }

  return repository.createManualBankTransferAtomically({ ...prepared, expectedInputSha256: computedHash });
}

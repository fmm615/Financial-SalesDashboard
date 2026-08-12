import { describe, expect, it } from "vitest";
import { parseStripeChargesCsv } from "@/server/services/stripe-charges-csv";

const headers = [
  "id", "Created date (UTC)", "Amount", "Amount Refunded", "Currency", "Captured", "Fee", "Mode", "Status",
  "Description", "Refunded date (UTC)", "Card Name", "Customer Description", "Customer Email", "Customer Phone",
  "Card Last4", "Card Address Line1", "Card Fingerprint", "client_ip (metadata)",
];

function csv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(`\uFEFF${headers.join(",")}\n${rows.map((row) => row.join(",")).join("\n")}`);
}

function row(values: Partial<Record<(typeof headers)[number], string>>): string[] {
  return headers.map((header) => values[header] ?? "");
}

describe("Stripe Charges CSV parser", () => {
  it("creates linked sale and refund evidence while retaining only safe source fields", () => {
    const parsed = parseStripeChargesCsv("Stripe Charges.csv", csv([
      row({ id: "ch_paid", "Created date (UTC)": "2026-08-09 09:37:33", Amount: "50.42", "Amount Refunded": "0.00", Currency: "usd", Captured: "TRUE", Fee: "0.50", Mode: "Live", Status: "Paid", "Card Name": "Ada Founder", "Customer Email": "Ada@Example.com", "Customer Phone": "+973 1700 0000", "Card Last4": "4242", "Card Address Line1": "Private address", "Card Fingerprint": "private-fingerprint", "client_ip (metadata)": "203.0.113.4" }),
      row({ id: "ch_refunded", "Created date (UTC)": "2026-08-08 17:52:15", Amount: "50.42", "Amount Refunded": "50.42", Currency: "usd", Captured: "TRUE", Fee: "0.50", Mode: "Live", Status: "Refunded", Description: "Membership", "Refunded date (UTC)": "2026-08-10 06:51:47", "Customer Description": "Refunded Member", "Customer Email": "refund@example.com" }),
      row({ id: "ch_failed", "Created date (UTC)": "2026-08-07 14:02:13", Amount: "50.42", "Amount Refunded": "0.00", Currency: "usd", Captured: "FALSE", Fee: "0.00", Mode: "Live", Status: "Failed", "Customer Email": "failed@example.com" }),
    ]));

    expect(parsed.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceEntryKey: "primary", kind: "sale", chargeId: "ch_paid", currency: "USD", credit: "50.42", customerName: "Ada Founder", customerEmail: "ada@example.com", customerPhone: "+973 1700 0000" }),
      expect.objectContaining({ sourceEntryKey: "primary", kind: "sale", chargeId: "ch_refunded", credit: "50.42" }),
      expect.objectContaining({ sourceEntryKey: "refund", kind: "refund", chargeId: "ch_refunded", debit: "50.42", occurredAt: "2026-08-10T06:51:47.000Z" }),
      expect.objectContaining({ sourceEntryKey: "primary", kind: "needs_review", chargeId: "ch_failed" }),
    ]));
    expect(parsed.rows.every((entry) => !("card last4" in entry.rawPayload) && !("card address line1" in entry.rawPayload) && !("card fingerprint" in entry.rawPayload) && !("client_ip (metadata)" in entry.rawPayload))).toBe(true);
    expect(parsed.rows).toHaveLength(4);
  });

  it("rejects source data that could make evidence ambiguous", () => {
    const missingHeader = headers.filter((header) => header !== "Status");
    const missingHeaderBytes = new TextEncoder().encode(`${missingHeader.join(",")}\n`);
    expect(() => parseStripeChargesCsv("Stripe Charges.csv", missingHeaderBytes)).toThrow(/status header/i);

    const duplicate = row({ id: "ch_duplicate", "Created date (UTC)": "2026-08-09 09:37:33", Amount: "50.42", "Amount Refunded": "0.00", Currency: "USD", Captured: "TRUE", Fee: "0.50", Mode: "Live", Status: "Paid" });
    expect(() => parseStripeChargesCsv("Stripe Charges.csv", csv([duplicate, duplicate]))).toThrow(/duplicate.*charge/i);

    expect(() => parseStripeChargesCsv("Stripe Charges.csv", csv([
      row({ id: "ch_bad_amount", "Created date (UTC)": "2026-08-09 09:37:33", Amount: "-50.42", "Amount Refunded": "0.00", Currency: "USD", Captured: "TRUE", Fee: "0.50", Mode: "Live", Status: "Paid" }),
    ]))).toThrow(/amount/i);

    expect(() => parseStripeChargesCsv("Stripe Charges.xlsx", csv([]))).toThrow(/\.csv/i);
  });

  it("retains a non-USD original currency as reviewable evidence without a conversion", () => {
    const parsed = parseStripeChargesCsv("Stripe Charges.csv", csv([
      row({ id: "ch_gbp", "Created date (UTC)": "2026-08-09 09:37:33", Amount: "453.75", "Amount Refunded": "0.00", Currency: "gbp", Captured: "TRUE", Fee: "5.52", Mode: "Live", Status: "Paid" }),
    ]));

    expect(parsed.rows).toEqual([expect.objectContaining({ kind: "sale", currency: "GBP", credit: "453.75" })]);
    expect(parsed.rows[0]?.rawPayload).not.toHaveProperty("converted amount");
  });
});

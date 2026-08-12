import { describe, expect, it } from "vitest";
import { parseTapStatementCsv } from "@/server/services/tap-statement-csv";

const headers = "postdate,txndate,description,product,reference_order,receipt,authid,payment_method,card,currency,debit,credit,balance,posting_id,issuer_country,scheme,charge_id,refund_id,destination_id";

function csv(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`\uFEFF${headers}\n${lines.join("\n")}`);
}

describe("Tap statement CSV parser", () => {
  it("retains and classifies every supported Tap statement line in original currency", () => {
    const parsed = parseTapStatementCsv("Tap Statement.csv", csv([
      "01/01/24 12:00 AM,01/01/24 12:00 AM,Opening Balance,,,,,,,BHD,,,0.000,1,,,,,",
      "02/01/24 11:35 AM,02/01/24 11:33 AM,Sale - Fatima,goSell,ord_1,,,,,BHD,,74.570,,2,,,chg_sale,,",
      "02/01/24 11:35 AM,02/01/24 11:33 AM,Fee - Transaction Processing,,,,,,,BHD,2.524,,,3,,,chg_sale,,",
      "02/01/24 11:35 AM,02/01/24 11:33 AM,VAT - Transaction Processing,,,,,,,BHD,0.252,,,4,,,chg_sale,,",
      "03/01/24 11:35 AM,03/01/24 11:33 AM,Transfer - AUB,,,,,,,BHD,,50,,5,,,,,dest_1",
      "04/01/24 11:35 AM,04/01/24 11:33 AM,Refund,,,,,,,BHD,74.570,,,6,,,chg_sale,re_1,",
      "05/01/24 11:35 AM,05/01/24 11:33 AM,Unexpected line,,,,,,,BHD,,,,7,,,,,",
    ]));

    expect(parsed.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "opening_balance", currency: "BHD", postingId: "1", occurredAt: null }),
      expect.objectContaining({ kind: "sale", paymentId: "chg_sale", credit: "74.570", currency: "BHD" }),
      expect.objectContaining({ kind: "processing_fee", debit: "2.524" }),
      expect.objectContaining({ kind: "fee_vat", debit: "0.252" }),
      expect.objectContaining({ kind: "transfer" }),
      expect.objectContaining({ kind: "refund", refundId: "re_1" }),
      expect.objectContaining({ kind: "needs_review" }),
    ]));
  });

  it("rejects a missing required header rather than guessing a source column", () => {
    const invalidHeader = headers.replace(",posting_id", ",statement_id");
    const bytes = new TextEncoder().encode(`${invalidHeader}\n`);

    expect(() => parseTapStatementCsv("tap.csv", bytes)).toThrow(/posting_id/i);
  });

  it("rejects duplicate Tap posting IDs before any evidence can be staged", () => {
    const line = "01/01/24,01/01/24,Opening Balance,,,,,,,BHD,,,0.000,1,,,,,";

    expect(() => parseTapStatementCsv("tap.csv", csv([line, line]))).toThrow(/duplicate.*posting_id/i);
  });

  it("rejects negative Tap debit and credit values", () => {
    expect(() => parseTapStatementCsv("tap.csv", csv(["01/01/24,01/01/24,Opening Balance,,,,,,,BHD,-1,,,1,,,,,"]))).toThrow(/debit/i);
  });

  it("rejects non-CSV filenames and more than 20,000 statement lines", () => {
    expect(() => parseTapStatementCsv("tap.xlsx", csv([]))).toThrow(/\.csv/i);
    const lines = Array.from({ length: 20_001 }, (_, index) => `01/01/24,01/01/24,Opening Balance,,,,,,,BHD,,,0.000,${index + 1},,,,,`);
    expect(() => parseTapStatementCsv("tap.csv", csv(lines))).toThrow(/20,000/i);
  });
});

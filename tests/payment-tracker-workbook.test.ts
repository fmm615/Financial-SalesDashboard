import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parsePaymentTrackerWorkbook } from "@/server/services/payment-tracker-workbook";

type SheetDefinition = { name: string; rows: Array<Array<ExcelJS.CellValue | null>> };

async function workbookBytes(sheets: SheetDefinition[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) worksheet.addRow(row);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

const b2cHeaders = ["Date", "Name", "Mobile", "Amount USD", "Type", "Pay Method", "year", "Note", "Payment Status"];
const b2cConsHeaders = ["Date", "Name", "Mobile", "Amount", "Category", "Membership Type", "Pay Method", "Month", "Year", "Note", "Payment Status"];

async function validWorkbookBytes(): Promise<Uint8Array> {
  return workbookBytes([
    {
      name: "B2C",
      rows: [
        b2cHeaders,
        [new Date(Date.UTC(2025, 9, 5)), "Reham Garash", "", 475, "B2C- Membership", "Stripe", 2025, "Full payment", "Received"],
      ],
    },
    {
      name: "B2C Cons",
      rows: [
        b2cConsHeaders,
        ["05/10/2025", "Reham Garash", "", 475, "B2C- Membership", "Individual Membership Plan", "Stripe", "October", 2025, "Full payment", "Received"],
      ],
    },
  ]);
}

describe("Payment Tracker workbook parser", () => {
  it("maps the two approved tabs while retaining source cells and an original-file hash", async () => {
    const parsed = await parsePaymentTrackerWorkbook("Payment Tracker.xlsx", await validWorkbookBytes());

    expect(parsed.acceptedTabs).toEqual(["B2C", "B2C Cons"]);
    expect(parsed.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceTab: "B2C", sourceRowNumber: 2, reportedDateRaw: "2025-10-05", amountUsdRaw: "475",
        customerNameRaw: "Reham Garash", paymentMethodRaw: "Stripe", rawPayload: expect.objectContaining({ Type: "B2C- Membership" }),
      }),
      expect.objectContaining({
        sourceTab: "B2C Cons", sourceRowNumber: 2, reportedDateRaw: "05/10/2025", amountUsdRaw: "475",
        declaredMonth: "October", declaredYear: "2025", membershipTypeRaw: "Individual Membership Plan",
      }),
    ]));
  });

  it("extracts a genuine Excel date cell by its actual calendar value, never by a locale-formatted guess", async () => {
    // A real Date-typed cell for 3 November 2025 would be genuinely ambiguous
    // if it were ever round-tripped through a slash-formatted string (03/11
    // vs 11/03). Reading it directly from the Date object's UTC fields must
    // never depend on any locale/display-format interpretation.
    const bytes = await workbookBytes([
      { name: "B2C", rows: [b2cHeaders, [new Date(Date.UTC(2025, 10, 3)), "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C", reportedDateRaw: "2025-11-03" })]),
    });
  });

  it("accepts the Finance workbook's lowercase B2C cons tab name as the canonical B2C Cons source", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [b2cHeaders, ["2025-10-05", "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C Cons" })]),
    });
  });

  it("ignores an unselected formula above the Finance header", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [[{ formula: "SUM(1:1)" }], b2cHeaders, ["2025-10-05", "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C", sourceRowNumber: 3 })]),
    });
  });

  it("retains a selected hyperlink's displayed text without retaining its URL", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [b2cHeaders, ["2025-10-05", { text: "Reham", hyperlink: "https://example.test/private" }, "", 475, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C", customerNameRaw: "Reham", rawPayload: expect.not.objectContaining({ Name: expect.stringContaining("example.test") }) })]),
    });
  });

  it("rejects a workbook that omits an approved Finance tab", async () => {
    const bytes = await workbookBytes([{ name: "B2C", rows: [b2cHeaders, ["2025-10-05", "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received"]] }]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).rejects.toThrow(/B2C Cons/i);
  });

  it("rejects a required Finance header instead of guessing its column", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [["Date", "Name", "Amount USD", "Type", "year", "Note", "Payment Status"], ["2025-10-05", "Reham", 475, "Membership", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).rejects.toThrow(/Pay Method/i);
  });

  it("retains a blank required source value for Finance review rather than dropping the row", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [b2cHeaders, ["", "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ sourceTab: "B2C", reportedDateRaw: "" })]),
    });
  });

  it("rejects a repeated required header", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [[...b2cHeaders, "Date"], ["2025-10-05", "Reham", "", 475, "Membership", "Stripe", 2025, "", "Received", "2025-10-05"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).rejects.toThrow(/repeated.*Date/i);
  });

  it("rejects unsupported filenames and malformed workbook bytes", async () => {
    const validBytes = await validWorkbookBytes();

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsm", validBytes)).rejects.toThrow(/\.xlsx/i);
    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/valid XLSX/i);
  });

  it("rejects a source formula that has no cached displayed value", async () => {
    const bytes = await workbookBytes([
      { name: "B2C", rows: [b2cHeaders, ["2025-10-05", "Reham", "", { formula: "475" }, "Membership", "Stripe", 2025, "", "Received"]] },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).rejects.toThrow(/formula.*cached/i);
  });

  it("rejects more than 20,000 extracted Finance rows", async () => {
    const largeRows: Array<Array<string | number>> = [b2cHeaders];
    for (let index = 0; index < 20_001; index += 1) largeRows.push(["2025-10-05", `Member ${index}`, "", 475, "Membership", "Stripe", 2025, "", "Received"]);
    const bytes = await workbookBytes([
      { name: "B2C", rows: largeRows },
      { name: "B2C Cons", rows: [b2cConsHeaders, ["05/10/2025", "Reham", "", 475, "Membership", "Individual", "Stripe", "October", 2025, "", "Received"]] },
    ]);

    await expect(parsePaymentTrackerWorkbook("payment-tracker.xlsx", bytes)).rejects.toThrow(/20,000/i);
  });
});

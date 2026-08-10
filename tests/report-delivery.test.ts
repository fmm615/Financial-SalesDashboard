import { describe, expect, it } from "vitest";
import { DisabledReportDeliveryProvider } from "@/lib/reports/delivery";

describe("disabled report delivery", () => {
  it("refuses a draft report delivery without contacting an email provider", async () => {
    const result = await new DisabledReportDeliveryProvider().requestDelivery({
      reportId: "11111111-1111-4111-8111-111111111111",
      readiness: "draft_fixture_only",
    });

    expect(result).toEqual({ status: "disabled", reason: "Email delivery is not enabled." });
  });
});

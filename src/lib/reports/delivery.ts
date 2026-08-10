import type { ReportReadiness } from "@/lib/reports/report-data";

export type ReportDeliveryRequest = {
  reportId: string;
  readiness: ReportReadiness;
};

export type ReportDeliveryResult = {
  status: "disabled";
  reason: "Email delivery is not enabled.";
};

export interface ReportDeliveryProvider {
  requestDelivery(input: ReportDeliveryRequest): Promise<ReportDeliveryResult>;
}

/**
 * Deliberately has no recipient, credential, HTTP, or database dependency.
 * Replace it only after Finance approves financial-ready report inputs.
 */
export class DisabledReportDeliveryProvider implements ReportDeliveryProvider {
  async requestDelivery(_: ReportDeliveryRequest): Promise<ReportDeliveryResult> {
    return { status: "disabled", reason: "Email delivery is not enabled." };
  }
}

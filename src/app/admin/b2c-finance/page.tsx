import { AppShell } from "@/components/app-shell";
import { B2cFinanceActionModule } from "@/features/b2c/b2c-finance-action-module";

export default function B2cFinanceAdministrationPage() {
  return <AppShell title="B2C Finance" description="Resolve Finance workbook decisions, retain the source audit trail, and then add only eligible payments to the B2C ledger.">
    <B2cFinanceActionModule />
  </AppShell>;
}

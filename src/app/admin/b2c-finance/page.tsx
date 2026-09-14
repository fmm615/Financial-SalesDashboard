import { redirect } from "next/navigation";

/**
 * Kept only so an existing bookmark still resolves. The Payment Tracker
 * workbook/posting system this page used to administer has been removed
 * entirely; there is no longer a Finance posting surface to redirect into.
 */
export default function B2cFinanceAdministrationPage() {
  redirect("/operations/b2c?tab=work");
}

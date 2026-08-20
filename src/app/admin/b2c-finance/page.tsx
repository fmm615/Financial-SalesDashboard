import { redirect } from "next/navigation";

/** Kept only so an existing bookmark still resolves. The Work queue's Ready-to-post filter is now the one Finance posting surface. */
export default function B2cFinanceAdministrationPage() {
  redirect("/operations/b2c?tab=work&queue=ready_to_post");
}

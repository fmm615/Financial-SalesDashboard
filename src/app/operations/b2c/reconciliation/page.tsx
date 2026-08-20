import { redirect } from "next/navigation";

/** Kept only so an existing bookmark still resolves. Sources is now the one owner of provider sync, upload, and coverage. */
export default function B2cReconciliationRoute() {
  redirect("/operations/b2c?tab=sources");
}

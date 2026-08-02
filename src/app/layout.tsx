import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { RoleProvider, type AppRole } from "@/lib/auth/role-context";

export const metadata: Metadata = { title: "PLAYBOOK | Financial Operating System", description: "PLAYBOOK financial and sales dashboard UI foundation" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const roleHeader = requestHeaders.get("x-playbook-role");
  const role: AppRole | null = roleHeader === "admin" || roleHeader === "viewer" ? roleHeader : null;
  return <html lang="en"><body><RoleProvider role={role}>{children}</RoleProvider></body></html>;
}

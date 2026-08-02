import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "PLAYBOOK | Financial Operating System", description: "PLAYBOOK financial and sales dashboard UI foundation" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

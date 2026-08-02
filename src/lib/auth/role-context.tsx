"use client";

import { createContext, useContext, type ReactNode } from "react";

export type AppRole = "admin" | "viewer";

// Standalone component tests do not mount the app layout. Real routes always mount
// RoleProvider from the server-rendered root layout.
const RoleContext = createContext<AppRole | null>("admin");

export function RoleProvider({ role, children }: { role: AppRole | null; children: ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useAppRole(): AppRole | null {
  return useContext(RoleContext);
}

export function useCanManage(): boolean {
  return useAppRole() === "admin";
}

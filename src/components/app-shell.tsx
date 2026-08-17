"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bell, BookOpenCheck, Building2, ChevronRight, FileBarChart2, GitCompareArrows, Landmark, LayoutDashboard, LogOut, Menu, Settings, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { drawerTransition, fadeTransition, pageTransition, staggerContainer } from "@/lib/motion";
import { useAppRole } from "@/lib/auth/role-context";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const navigation = [
  { href: "/executive", label: "Executive", icon: LayoutDashboard, group: "Overview" },
  { href: "/operations/b2c", label: "B2C operations", icon: Building2, group: "Operations" },
  { href: "/operations/b2c/reconciliation", label: "B2C reconciliation", icon: GitCompareArrows, group: "Operations" },
  { href: "/admin/b2c-finance", label: "B2C Finance", icon: Landmark, group: "Operations", adminOnly: true },
  { href: "/operations/b2b", label: "B2B operations", icon: Building2, group: "Operations" },
  { href: "/finance", label: "Finance", icon: Landmark, group: "Operations" },
  { href: "/finance/targets", label: "Targets", icon: Landmark, group: "Operations" },
  { href: "/reports", label: "Reports", icon: FileBarChart2, group: "Governance" },
  { href: "/review-queue", label: "Review queue", icon: BookOpenCheck, group: "Governance" },
  { href: "/audit-log", label: "Audit log", icon: ShieldCheck, group: "Governance", adminOnly: true },
  { href: "/admin", label: "Administration", icon: Settings, group: "Governance", adminOnly: true },
];

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const role = useAppRole();
  const visibleNavigation = navigation.filter((item) => !item.adminOnly || role === "admin");
  let activeGroup = "";
  return <nav aria-label="Main navigation" className="flex h-full flex-col bg-brand-primary text-white">
    <Link href="/executive" className="mx-3 mt-3 flex items-center justify-between rounded-card border border-white/10 bg-white/[0.06] px-4 py-4 transition-colors hover:bg-white/[0.1]" onClick={onNavigate}>
      <span className="text-sm font-semibold tracking-[0.15em]">PLAYBOOK</span><span className="rounded-pill bg-brand-lime px-2 py-0.5 text-[9px] font-bold tracking-[0.1em] text-brand-primary">FOS</span>
    </Link>
    <div className="mt-5 space-y-1 px-3">{visibleNavigation.map((item) => {
      const showGroup = item.group !== activeGroup;
      activeGroup = item.group;
      const active = pathname === item.href;
      return <div key={item.href}>{showGroup && <p className="px-3 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-[0.15em] text-white/40">{item.group}</p>}<Link href={item.href} onClick={onNavigate} className={`group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${active ? "bg-white text-brand-primary shadow-sm" : "text-white/65 hover:bg-white/[0.09] hover:text-white"}`}><item.icon size={17} strokeWidth={1.8} className={active ? "text-brand-accent" : "text-white/55"} />{item.label}{active && <ChevronRight size={15} className="ml-auto text-brand-accent" />}</Link></div>;
    })}</div>
    <div className="mt-auto mx-3 mb-3 rounded-card border border-white/10 bg-white/[0.06] p-4"><div className="flex items-center gap-2 text-xs font-semibold text-white"><span className="h-2 w-2 rounded-full bg-brand-lime" />{role === "admin" ? "Admin workspace" : "Viewer workspace"}</div><p className="mt-1.5 text-xs leading-5 text-white/55">{role === "admin" ? "Changes are recorded in the audit log." : "Financial data is read-only."}</p></div>
  </nav>;
}

export function AppShell({ title, description, controls, children }: { title: string; description: string; controls?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false); const reducedMotion = useReducedMotion();
  const role = useAppRole();
  async function signOut() { try { await createBrowserSupabaseClient().auth.signOut(); } finally { window.location.assign("/login"); } }
  return <div className="min-h-screen overflow-x-hidden bg-canvas"><a href="#main-content" className="sr-only z-[60] rounded-md bg-brand-primary px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to main content</a><aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] overflow-y-auto lg:block"><NavContent /></aside><header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-border/80 bg-canvas/90 px-4 backdrop-blur-xl sm:px-6 lg:ml-[252px] lg:px-9"><button type="button" aria-label="Open navigation" className="flex h-11 w-11 items-center justify-center rounded-pill text-text-secondary hover:bg-surface-muted lg:hidden" onClick={() => setOpen(true)}><Menu size={21} /></button><div className="hidden lg:block"><p className="text-xs font-medium text-text-secondary">Financial workspace</p><p className="mt-0.5 text-[11px] text-text-muted">Controlled reporting &amp; traceable operations</p></div><div className="flex items-center gap-1"><span className="hidden rounded-pill bg-surface-muted px-2.5 py-1 text-[11px] font-medium capitalize text-text-secondary sm:inline">{role ?? ""}</span><button type="button" aria-label="Notifications" className="relative flex h-11 w-11 items-center justify-center rounded-pill text-text-secondary transition-colors hover:bg-surface-muted"><Bell size={19} /><span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-brand-lime ring-2 ring-canvas" /></button><button type="button" aria-label="Sign out" onClick={signOut} className="flex h-11 w-11 items-center justify-center rounded-pill text-text-secondary transition-colors hover:bg-surface-muted"><LogOut size={18} /></button></div></header><AnimatePresence>{open && <motion.div variants={reducedMotion ? undefined : fadeTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} className="fixed inset-0 z-50 bg-brand-primary/40 lg:hidden" onClick={() => setOpen(false)}><motion.aside variants={reducedMotion ? undefined : drawerTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} exit={reducedMotion ? undefined : "exit"} className="h-full w-[294px] overflow-y-auto shadow-elevated" onClick={(event) => event.stopPropagation()}><button type="button" aria-label="Close navigation" className="absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-pill bg-white/10 text-white hover:bg-white/20" onClick={() => setOpen(false)}><X size={19} /></button><NavContent onNavigate={() => setOpen(false)} /></motion.aside></motion.div>}</AnimatePresence><motion.main id="main-content" variants={reducedMotion ? undefined : pageTransition} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"} className="px-4 py-7 sm:px-6 lg:ml-[252px] lg:px-9 lg:py-9"><div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-start"><div className="max-w-3xl"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-brand-accent">PLAYBOOK Financial Operating System</p><h1 className="text-[27px] font-semibold leading-tight tracking-[-0.04em] text-text-primary sm:text-[31px]">{title}</h1><p className="mt-2.5 text-sm leading-6 text-text-muted">{description}</p></div>{controls && <div className="shrink-0">{controls}</div>}</div><motion.div variants={reducedMotion ? undefined : staggerContainer} initial={reducedMotion ? false : "initial"} animate={reducedMotion ? undefined : "animate"}>{children}</motion.div></motion.main></div>;
}

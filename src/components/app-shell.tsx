"use client";

import { Bell, BookOpenCheck, Building2, ChevronDown, FileBarChart2, Landmark, LayoutDashboard, Menu, Settings, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

const navigation = [
  { href: "/executive", label: "Executive", icon: LayoutDashboard },
  { href: "/operations/b2c", label: "B2C", icon: Building2, group: "Operations" },
  { href: "/operations/b2b", label: "B2B", icon: Building2, group: "Operations" },
  { href: "/finance", label: "Finance", icon: Landmark },
  { href: "/reports", label: "Reports", icon: FileBarChart2 },
  { href: "/review-queue", label: "Review Queue", icon: BookOpenCheck },
  { href: "/admin", label: "Admin", icon: Settings },
  { href: "/audit-log", label: "Audit Log", icon: ShieldCheck },
];

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <nav aria-label="Main navigation" className="flex h-full flex-col"><Link href="/executive" className="px-5 py-7 text-lg font-medium tracking-[0.14em] text-ink" onClick={onNavigate}>PLAYBOOK<span className="ml-1 text-xs tracking-normal text-slate-500">FOS</span></Link><div className="space-y-1 px-3">{navigation.map((item, index) => <div key={item.href}>{item.group && (index === 1) && <p className="px-3 pb-2 pt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{item.group}</p>}<Link href={item.href} onClick={onNavigate} className={`flex items-center gap-3 px-3 py-2.5 text-sm ${pathname === item.href ? "bg-mint text-forest" : "text-slate-600 hover:bg-stone hover:text-ink"}`}><item.icon size={17} strokeWidth={1.75} />{item.label}</Link></div>)}</div><div className="mt-auto border-t border-line p-4"><p className="text-xs font-medium text-slate-500">UI foundation</p><p className="mt-1 text-xs text-slate-400">Live access control coming later</p></div></nav>;
}

export function AppShell({ title, description, controls, children }: { title: string; description: string; controls?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="min-h-screen lg:grid lg:grid-cols-[230px_minmax(0,1fr)]"><aside className="fixed inset-y-0 hidden w-[230px] border-r border-line bg-white lg:block"><NavContent /></aside><header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-[#f7f7f3]/95 px-4 backdrop-blur lg:px-8"><button type="button" aria-label="Open navigation" className="p-2 text-slate-600 lg:hidden" onClick={() => setOpen(true)}><Menu size={21} /></button><div className="hidden lg:block" /><div className="flex items-center gap-3"><button type="button" aria-label="Notifications" className="relative p-2 text-slate-600"><Bell size={19} /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber" /></button><button type="button" className="flex items-center gap-2 border-l border-line pl-3 text-left"><span className="grid h-8 w-8 place-items-center rounded-full bg-forest text-xs font-medium text-white">MA</span><span className="hidden sm:block"><span className="block text-sm font-medium text-ink">Maya Al Khalifa</span><span className="block text-xs text-slate-500">Management</span></span><ChevronDown size={14} className="text-slate-500" /></button></div></header>{open && <div className="fixed inset-0 z-50 bg-ink/25 lg:hidden" onClick={() => setOpen(false)}><aside className="h-full w-[280px] bg-white shadow-xl" onClick={(event) => event.stopPropagation()}><button type="button" aria-label="Close navigation" className="absolute left-[238px] top-4 p-2 text-slate-600" onClick={() => setOpen(false)}><X /></button><NavContent onNavigate={() => setOpen(false)} /></aside></div>}<main className="px-4 py-7 sm:px-6 lg:px-8"><div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-start"><div><h1 className="text-2xl font-medium tracking-tight text-ink">{title}</h1><p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p></div>{controls && <div className="shrink-0">{controls}</div>}</div>{children}</main></div>;
}

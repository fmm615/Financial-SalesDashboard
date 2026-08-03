"use client";

import { CalendarDays, ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function monthOptions(selectedMonth: string): { value: string; label: string }[] {
  const selectedYear = Number(selectedMonth.slice(0, 4));
  const currentYear = new Date().getUTCFullYear();
  const firstYear = Math.min(2022, selectedYear);
  const lastYear = Math.max(currentYear, selectedYear);
  const options: { value: string; label: string }[] = [];
  for (let year = lastYear; year >= firstYear; year -= 1) {
    for (let month = 11; month >= 0; month -= 1) {
      const value = `${year}-${String(month + 1).padStart(2, "0")}`;
      options.push({ value, label: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month, 1))) });
    }
  }
  return options;
}

/** A visible, keyboard-accessible selector for B2B financial reporting periods. */
export function B2bPeriodSelector({ month }: { month: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  function selectMonth(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", value);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return <div className="relative inline-flex items-center rounded-pill border border-border bg-surface text-sm font-medium text-text-secondary shadow-card hover:border-brand-accent/30 hover:text-text-primary">
    <CalendarDays size={15} aria-hidden="true" className="pointer-events-none ml-3.5 shrink-0" />
    <select aria-label="B2B financial reporting month" value={month} onChange={(event) => selectMonth(event.target.value)} className="cursor-pointer appearance-none bg-transparent py-2 pl-2 pr-8 text-sm font-medium outline-none">
      {monthOptions(month).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <ChevronDown size={15} aria-hidden="true" className="pointer-events-none absolute right-3.5" />
  </div>;
}

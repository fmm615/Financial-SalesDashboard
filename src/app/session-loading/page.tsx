import { SubtleLoading } from "@/components/ui";
export default function SessionLoadingPage() { return <main className="grid min-h-screen place-items-center bg-canvas"><div className="rounded-card bg-surface p-6 text-center shadow-card"><SubtleLoading /><p className="mt-3 text-sm text-text-muted">Checking your session…</p></div></main>; }

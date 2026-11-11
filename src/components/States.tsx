import { AlertTriangle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, cx } from "./ui";

export function EmptyState({ icon: Icon, title, body, action, className }: { icon: LucideIcon; title: string; body?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center animate-rise", className)}>
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-white/[.05] text-fg-muted ring-1 ring-white/[.06]">
        <Icon size={26} strokeWidth={1.6} />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {body && <p className="mt-1.5 text-fg-muted">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Something went wrong"
      body={message}
      action={onRetry && <Button onClick={onRetry}>Try again</Button>}
    />
  );
}

export function PosterSkeletonRow({ count = 8, landscape = false }: { count?: number; landscape?: boolean }) {
  return (
    <div className="mb-8">
      <div className="gutter-x mb-3"><div className="skeleton h-6 w-48 rounded-md" /></div>
      <div className="flex gap-4 overflow-hidden px-[var(--gutter)] pt-2">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={cx("skeleton shrink-0 rounded-poster", landscape ? "aspect-video w-[calc(var(--poster-w)*1.75)]" : "aspect-[2/3] w-[var(--poster-w)]")} />
        ))}
      </div>
    </div>
  );
}

export function PosterSkeletonGrid({ count = 18 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(var(--grid-min,168px),1fr))] gap-x-4 gap-y-6">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-poster" />)}
    </div>
  );
}

export function HeroSkeleton() {
  return (
    <div className="relative h-[min(70vh,720px)] min-h-[440px] bg-surface-1">
      <div className="gutter-x absolute bottom-[18%] w-full max-w-2xl space-y-4">
        <div className="skeleton h-14 w-3/4 rounded-lg" />
        <div className="skeleton h-4 w-1/3 rounded" />
        <div className="skeleton h-16 w-full rounded" />
        <div className="flex gap-3"><div className="skeleton h-12 w-36 rounded-full" /><div className="skeleton h-12 w-36 rounded-full" /></div>
      </div>
    </div>
  );
}

/** Shown instead of a description when no real metadata has been fetched for a title yet. */
export function NoDetails({ className }: { className?: string }) {
  return (
    <p className={cx("mt-7 max-w-[640px] text-[14px] leading-6 text-fg-subtle", className)}>
      No description yet. Details come from TMDB:{" "}
      <Link to="/library" className="text-fg-muted underline-offset-4 hover:text-fg hover:underline">Library → Metadata</Link>.
    </p>
  );
}

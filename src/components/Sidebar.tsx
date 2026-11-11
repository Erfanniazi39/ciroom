import { BarChart3, Clapperboard, Heart, Home, Library, Search, Settings, Tv } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cx } from "./ui";

const main: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/movies", label: "Movies", icon: Clapperboard },
  { to: "/series", label: "Series", icon: Tv },
  { to: "/my-list", label: "My List", icon: Heart },
];

/**
 * Slim icon rail that expands into labels on hover. It floats over content
 * (no layout shift) and stays out of the way of the artwork.
 */
export function Sidebar({ onSearch }: { onSearch: () => void }) {
  return (
    <nav
      aria-label="Main"
      className="group/rail fixed inset-y-0 left-0 z-40 hidden w-rail flex-col md:flex bg-gradient-to-r from-bg via-bg/95 to-bg/0 py-6 transition-[width,background-color] duration-300 ease-out hover:w-[224px] focus-within:w-[224px] hover:bg-surface-1/95 focus-within:bg-surface-1/95 hover:shadow-[20px_0_60px_-20px_rgb(0_0_0/.8)]"
    >
      <div className="mb-10 flex h-10 items-center gap-3 px-[22px]">
        <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden>
          <path d="M47 17.5A21 21 0 1 0 47 46.5" fill="none" stroke="rgb(var(--accent))" strokeWidth="7" strokeLinecap="round" />
          <path d="M27 23.5v17a1.6 1.6 0 0 0 2.4 1.4l14.2-8.5a1.6 1.6 0 0 0 0-2.8L29.4 22.1a1.6 1.6 0 0 0-2.4 1.4z" fill="rgb(var(--accent))" />
        </svg>
        <span className="font-display text-xl font-semibold tracking-tight opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100"><span className="text-accent">Ci</span>Room</span>
        {__CIROOM_DEV__ && (
          <span title="Test version: uses a copy of your data" className="absolute left-[18px] top-[58px] rounded bg-orange-500 px-1.5 py-px text-[10px] font-bold tracking-wider text-black">DEV</span>
        )}
      </div>

      <ul className="flex flex-col gap-1 px-3">
        {main.map((item) => (
          <li key={item.to}>
            <RailLink {...item} />
          </li>
        ))}
      </ul>

      <ul className="mt-auto flex flex-col gap-1 px-3">
        <li>
          <button onClick={onSearch} className={itemClass(false)}>
            <Search size={22} strokeWidth={1.8} className="shrink-0" />
            <Label>Search</Label>
            <kbd className="micro ml-auto rounded bg-white/10 px-1.5 py-0.5 text-fg-subtle opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">Ctrl K</kbd>
          </button>
        </li>
        <li>
          <RailLink to="/library" label="Library" icon={Library} />
        </li>
        <li>
          <RailLink to="/stats" label="Your watching" icon={BarChart3} />
        </li>
        <li>
          <RailLink to="/settings" label="Settings" icon={Settings} />
        </li>
      </ul>
    </nav>
  );
}

function RailLink({ to, label, icon: Icon, end }: { to: string; label: string; icon: LucideIcon; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => itemClass(isActive)}>
      {({ isActive }) => (
        <>
          <span className={cx("absolute left-0 h-5 w-[3px] rounded-r-full bg-accent transition-opacity", isActive ? "opacity-100" : "opacity-0")} />
          <Icon size={22} strokeWidth={isActive ? 2.2 : 1.8} className="shrink-0" />
          <Label>{label}</Label>
        </>
      )}
    </NavLink>
  );
}

const itemClass = (active: boolean) =>
  cx(
    "relative flex h-11 w-full items-center gap-4 overflow-hidden rounded-xl px-[14px] text-[14px] font-medium transition-colors duration-200",
    active ? "text-fg" : "text-fg-subtle hover:bg-white/[.05] hover:text-fg",
  );

const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">{children}</span>
);

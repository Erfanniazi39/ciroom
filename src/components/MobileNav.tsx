import { Clapperboard, Heart, Home, Search, Tv, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router-dom";
import { cx } from "./ui";

const items: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/movies", label: "Movies", icon: Clapperboard },
  { to: "/series", label: "Series", icon: Tv },
  { to: "/my-list", label: "My List", icon: Heart },
];

/** Bottom tab bar for phones (the side rail is hidden below the md breakpoint). */
export function MobileNav({ onSearch }: { onSearch: () => void }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-white/[.06] bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => cx("flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors", isActive ? "text-fg" : "text-fg-subtle")}
        >
          {({ isActive }) => (
            <>
              <Icon size={22} strokeWidth={isActive ? 2.3 : 1.8} className={isActive ? "text-accent" : ""} />
              {label}
            </>
          )}
        </NavLink>
      ))}
      <button onClick={onSearch} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-fg-subtle">
        <Search size={22} strokeWidth={1.8} />
        Search
      </button>
    </nav>
  );
}

/** True when the app is opened from another device (e.g. a phone): the mpv "Full player" lives on the PC. */
export const isRemoteClient = () => !["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { Compass } from "lucide-react";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { PlayerHost } from "@/components/PlayerHost";
import { SearchPalette } from "@/components/SearchPalette";
import { MobileNav } from "@/components/MobileNav";
import { Sidebar } from "@/components/Sidebar";
import { EmptyState, ErrorState } from "@/components/States";
import { useRemoteLink } from "@/lib/remoteLink";
import { usePartyLink } from "@/lib/partyLink";
import { PartyPanel } from "@/components/PartyPanel";
import { useHotkey } from "@/hooks/useHotkey";
import { setTvMode, useTvMode } from "@/hooks/useTvMode";
import { useSettings } from "@/store/settings";
import { useLibrary } from "@/store/library";
import { usePlayer } from "@/store/player";
import Browse from "@/pages/Browse";
import CollectionDetail from "@/pages/CollectionDetail";
import Health from "@/pages/Health";
import Home from "@/pages/Home";
import LibraryPage from "@/pages/LibraryPage";
import MovieDetail from "@/pages/MovieDetail";
import MyList from "@/pages/MyList";
import SeriesDetail from "@/pages/SeriesDetail";
import Settings from "@/pages/Settings";
import Stats from "@/pages/Stats";
import Watch from "@/pages/Watch";

export default function App() {
  const { load, error } = useLibrary();
  const [searchOpen, setSearchOpen] = useState(false);
  const playing = usePlayer((s) => !!s.current);
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const navType = useNavigationType();
  const scrollPositions = useRef(new Map<string, number>());

  useEffect(() => { load(); }, [load]);

  const openSearch = useCallback(() => setSearchOpen(true), []);
  useHotkey("mod+k", openSearch);
  useHotkey("/", openSearch);
  useTvMode();
  useRemoteLink();
  usePartyLink();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); setTvMode(!useSettings.getState().tvMode); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll restoration for the inner scroll pane: restore on Back/Forward, top otherwise.
  // Query-only changes (filters, season tabs) keep the current position.
  const lastPath = useRef(location.pathname);
  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const samePage = lastPath.current === location.pathname;
    lastPath.current = location.pathname;
    if (samePage) return;
    const saved = scrollPositions.current.get(location.key);
    el.scrollTop = navType === "POP" && saved !== undefined ? saved : 0;
  }, [location.key, location.pathname, navType]);

  const onScroll = () => {
    if (mainRef.current) scrollPositions.current.set(location.key, mainRef.current.scrollTop);
  };

  return (
    <div className="h-full">
      <Sidebar onSearch={openSearch} />
      <main ref={mainRef} onScroll={onScroll} className={`h-full overflow-y-auto overflow-x-hidden pb-16 transition-[padding] duration-300 md:pb-0 md:pl-rail ${playing ? "md:pb-32" : ""}`}>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : (
          <div key={location.pathname} className="animate-fade">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/movies" element={<Browse kind="movie" />} />
              <Route path="/movies/:id" element={<MovieDetail />} />
              <Route path="/collections/:id" element={<CollectionDetail />} />
              <Route path="/series" element={<Browse kind="series" />} />
              <Route path="/series/:id" element={<SeriesDetail />} />
              <Route path="/watch/:id" element={<Watch />} />
              <Route path="/my-list" element={<MyList />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/health" element={<Health />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<EmptyState className="pt-[20vh]" icon={Compass} title="Nothing here" body="This page doesn't exist." />} />
            </Routes>
          </div>
        )}
      </main>
      <MobileNav onSearch={openSearch} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <PlayerHost />
      <NowPlayingBar />
      <PartyPanel />
    </div>
  );
}

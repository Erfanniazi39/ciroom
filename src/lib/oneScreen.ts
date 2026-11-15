/**
 * One screen at a time (PC side). When a phone starts playing the title the PC is playing, the PC pauses and
 * remembers that ("elsewhere"). While it is elsewhere the PC must not save its old position (that would rewind the
 * phone's progress), and when it plays again it continues from where the phone was.
 */
import { usePlayback } from "@/store/playback";
import { useUser } from "@/store/user";

/** True while this title is playing on a phone (the PC paused for it). */
export const isElsewhere = (id: string): boolean => usePlayback.getState().elsewhere?.id === id;

/**
 * The PC is about to play `id` again. Clears the "elsewhere" state; returns the position to jump to
 * (the phone's live position), or null when the PC should stay where it is (within 3 s, or nothing newer is known).
 */
export function takeBack(id: string, here: number): number | null {
  const pb = usePlayback.getState();
  const e = pb.elsewhere;
  if (!e || e.id !== id) return null;
  usePlayback.setState({ elsewhere: null });
  let there: number | null = null;
  const pn = pb.phoneNow[id];
  if (pn && pn.at >= e.at - 5000) there = pn.position + (pn.playing ? Math.max(0, (Date.now() - pn.at) / 1000) : 0);
  else {
    const p = useUser.getState().progress[id];
    if (p && p.updatedAt > e.at) there = p.position;
  }
  return there !== null && Number.isFinite(there) && Math.abs(there - here) > 3 ? there : null;
}

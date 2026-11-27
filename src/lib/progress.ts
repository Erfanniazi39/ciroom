/**
 * Rules over one saved progress entry, shared by the PC window and the phone page.
 */
import type { Progress } from "@/types/media";

/** Watched at ≥ 90%, or < 3 min remaining. The 3-min rule only applies to videos long enough for it to mean something:
 *  a 2-minute clip would otherwise count as watched the moment it starts. */
export const isCompleted = (position: number, duration: number) =>
  duration > 0 && (position / duration >= 0.9 || (duration > 600 && duration - position < 180));

/**
 * Saved progress worth resuming: past `min` seconds and not at the end. `watched` stays true once a title was finished
 * (it is history: Stats, ✓ marks), so a finished title watched again and left half way resumes too (D-13): its
 * position moved back from the end. "Mark as watched" puts the position at the end, "Mark as unwatched" at 0.
 */
export const canResume = (p: Progress | undefined, min = 60): p is Progress =>
  !!p && p.position > min && !isCompleted(p.position, p.duration);

/** Show a progress bar: anything not finished, or a finished title being watched again. */
export const showsProgress = (p: Progress | undefined): p is Progress => !!p && (!p.watched || canResume(p, 0));

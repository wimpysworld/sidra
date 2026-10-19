import type { NowPlayingPayload } from "./player";

/** Maximum context sent across IPC and published through MPRIS. */
export const TRACK_LIST_LIMIT = 21;

/** A particular appearance of an item in MusicKit's queue. */
export interface QueueItem extends NowPlayingPayload {
  occurrenceId: string;
}

/** A bounded context around the current item, in MusicKit queue order. */
export interface QueueSnapshot {
  items: QueueItem[];
  currentOccurrenceId: string | null;
}

/** IDs contain document, instance and object generations, never Apple identifiers. */
export function isOccurrenceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 &&
    /^d\d+_i\d+_o\d+$/.test(value);
}

/** Map an opaque occurrence to a stable D-Bus object path. */
export function occurrenceTrackId(occurrenceId: string): string {
  return `/org/sidra/tracklist/${occurrenceId}`;
}

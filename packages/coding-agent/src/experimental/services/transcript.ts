import { type Context, defineService } from "@earendil-works/chord";
import type { LaneSnapshot } from "@earendil-works/pi-protocol";

export interface TranscriptSnapshot {
	revision: number;
	lane: LaneSnapshot;
}

export interface Transcript {
	/** Authoritative snapshot at one transcript revision. */
	snapshot(context: Context): Promise<TranscriptSnapshot>;
}

export const Transcript = defineService<Transcript>("pi.transcript");

import { type Context, defineService, type RemoteJson } from "@earendil-works/pi-agent-core";
import type { LaneSnapshot } from "@earendil-works/pi-protocol";

export interface TranscriptSnapshot {
	revision: number;
	lane: RemoteJson<LaneSnapshot>;
}

export interface Transcript {
	/** Authoritative snapshot at one transcript revision. */
	snapshot(context: Context): Promise<TranscriptSnapshot>;
}

export const Transcript = defineService<Transcript>("pi.transcript");

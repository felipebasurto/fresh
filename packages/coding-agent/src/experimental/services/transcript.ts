import { type Context, defineService, type RemoteEvents, type RemoteJson } from "@earendil-works/pi-agent-core";
import type { LaneEvent, LaneSnapshot } from "@earendil-works/pi-protocol";

export interface TranscriptSnapshot {
	revision: number;
	lane: RemoteJson<LaneSnapshot>;
}

export interface TranscriptEvent {
	type: "lane_event";
	revision: number;
	event: RemoteJson<LaneEvent>;
}

export interface Transcript {
	/** Authoritative snapshot at one transcript revision. */
	snapshot(context: Context): Promise<TranscriptSnapshot>;
	/** Ordered semantic deltas; final message events replace streamed projections authoritatively. */
	readonly events: RemoteEvents<TranscriptEvent>;
}

export const Transcript = defineService<Transcript>("pi.transcript");

import { type HarnessEvent, type LaneSnapshot, reduceLaneSnapshot } from "@earendil-works/pi-agent-core";
import type { LaneWatch } from "@earendil-works/pi-client";
import type { LaneEvent as WireLaneEvent, LaneSnapshot as WireLaneSnapshot } from "@earendil-works/pi-protocol";

export interface LaneWatchSource {
	watchSession(sessionId: string): Promise<LaneWatch>;
}

export interface LaneReplica {
	readonly sessionId: string;
	state(): LaneSnapshot;
	subscribe(listener: () => void): () => void;
	close(): Promise<void>;
}

/**
 * Open the protocol's coherent snapshot/event watch as a presentation-local Harness replica.
 *
 * The protocol DTOs are the strict-JSON projection of these Harness types. Keeping the cast here
 * lets every presentation use the Harness's normative reducer instead of maintaining a second fold.
 */
export async function openLaneReplica(source: LaneWatchSource, sessionId: string): Promise<LaneReplica> {
	const watch = await source.watchSession(sessionId);
	const listeners = new Set<() => void>();
	let snapshot = fromWireSnapshot(watch.snapshot);
	let closed = false;
	const publish = (): void => {
		if (closed) return;
		for (const listener of listeners) listener();
	};

	await watch.start(async (wireEvent) => {
		if (closed) return;
		const folded = reduceLaneSnapshot(snapshot, fromWireEvent(wireEvent));
		if ("rebase" in folded) snapshot = fromWireSnapshot(await watch.resnapshot());
		else snapshot = folded;
		publish();
	});

	return {
		sessionId,
		state: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			if (closed) return;
			closed = true;
			listeners.clear();
			await watch.dispose();
		},
	};
}

function fromWireSnapshot(snapshot: WireLaneSnapshot): LaneSnapshot {
	return snapshot as unknown as LaneSnapshot;
}

function fromWireEvent(event: WireLaneEvent): HarnessEvent {
	return event as unknown as HarnessEvent;
}

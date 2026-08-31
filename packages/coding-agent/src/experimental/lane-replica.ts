import type { LaneSnapshot, LaneWatchEvent } from "@earendil-works/pi-agent-core";
import type { Transcript } from "./services/transcript.ts";

export interface LaneReplica {
	state(): LaneSnapshot;
	subscribe(listener: () => void): () => void;
	close(): Promise<void>;
}

/** Open a presentation-local replica from the Session's Transcript state. */
export async function openLaneReplica(
	transcript: Transcript,
	onEvent?: (event: LaneWatchEvent) => void | Promise<void>,
): Promise<LaneReplica> {
	const listeners = new Set<() => void>();
	let snapshot: LaneSnapshot | undefined;
	let initialized = false;
	let closed = false;
	let deliveryTail = Promise.resolve();
	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	const publish = (): void => {
		if (closed) return;
		for (const listener of listeners) listener();
	};
	const unsubscribe = transcript.state.subscribe((value, _context, delivery) => {
		if (closed || value.snapshot === null) return;
		snapshot = value.snapshot;
		publish();
		if (!initialized) {
			initialized = true;
			resolveReady();
		}
		if (delivery.kind === "update" && value.event !== null) {
			const event = value.event;
			deliveryTail = deliveryTail.then(() => onEvent?.(event));
		}
	});

	try {
		await ready;
	} catch (error) {
		closed = true;
		unsubscribe();
		throw error;
	}

	return {
		state() {
			if (snapshot === undefined) throw new Error("Transcript replica has no snapshot");
			return snapshot;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			if (closed) return;
			closed = true;
			unsubscribe();
			listeners.clear();
			await deliveryTail;
		},
	};
}

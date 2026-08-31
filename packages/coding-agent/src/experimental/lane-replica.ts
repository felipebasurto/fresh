import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type LaneSnapshot, type LaneWatchEvent, reduceLaneSnapshot } from "@earendil-works/pi-agent-core";
import type { Transcript, TranscriptSnapshot, TranscriptUpdate } from "./services/transcript.ts";

export interface LaneReplica {
	readonly sessionId: string;
	state(): LaneSnapshot;
	subscribe(listener: () => void): () => void;
	close(): Promise<void>;
}

/** Open a presentation-local Harness replica from the Session's Transcript service. */
export async function openLaneReplica(
	transcript: Transcript,
	sessionId: string,
	onEvent?: (event: LaneWatchEvent) => void | Promise<void>,
): Promise<LaneReplica> {
	const listeners = new Set<() => void>();
	const pending: TranscriptUpdate[] = [];
	let snapshot: LaneSnapshot | undefined;
	let revision = 0;
	let initialized = false;
	let closed = false;
	let deliveryTail = Promise.resolve();

	const publish = (): void => {
		if (closed) return;
		for (const listener of listeners) listener();
	};
	const installSnapshot = (captured: TranscriptSnapshot): void => {
		revision = captured.revision;
		snapshot = captured.snapshot;
		publish();
	};
	const apply = async (update: TranscriptUpdate): Promise<void> => {
		if (closed || update.revision <= revision) return;
		if (update.revision !== revision + 1) {
			installSnapshot(await transcript.snapshot(BACKGROUND_CONTEXT));
			if (update.revision <= revision) return;
			if (update.revision !== revision + 1) throw new Error("Transcript snapshot did not repair its revision gap");
		}
		if (update.type === "snapshot") {
			revision = update.revision;
			snapshot = update.snapshot;
			publish();
			return;
		}
		const event = update.event;
		const current = snapshot;
		if (current === undefined) throw new Error("Transcript replica has no snapshot");
		const reduced = reduceLaneSnapshot(current, event);
		revision = update.revision;
		if (!("rebase" in reduced)) {
			snapshot = reduced;
			publish();
		}
		await onEvent?.(event);
	};
	const enqueue = (update: TranscriptUpdate): void => {
		const detached = structuredClone(update);
		deliveryTail = deliveryTail.then(() => apply(detached));
	};
	const unsubscribe = transcript.updates.subscribe((update) => {
		if (closed || update === null) return;
		if (initialized) enqueue(update);
		else pending.push(structuredClone(update));
	});

	try {
		installSnapshot(await transcript.snapshot(BACKGROUND_CONTEXT));
		initialized = true;
		for (const update of pending.splice(0)) enqueue(update);
		await deliveryTail;
	} catch (error) {
		closed = true;
		unsubscribe();
		throw error;
	}

	return {
		sessionId,
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

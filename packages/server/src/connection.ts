import type { ClientMessageDecoder } from "@earendil-works/pi-protocol";

import type { MaybePromise } from "./types.ts";

/** An established, authorized ordered byte connection. */
export interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): MaybePromise<void>;
}

export interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

export type ConnectionStage = "awaitingHello" | "handshaking" | "ready" | "closing" | "closed";

export interface ConnectionState {
	connection: ByteConnection;
	decoder: ClientMessageDecoder;
	stage: ConnectionStage;
	disconnected: boolean;
	handshake?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
	activeRequests: Map<string, AbortController>;
}

export function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}

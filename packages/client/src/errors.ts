import type { ProtocolError, ProtocolErrorCode } from "@earendil-works/pi-protocol";

export class PiServerError extends Error {
	readonly code: ProtocolErrorCode;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "PiServerError";
		this.code = error.code;
	}
}

export class PiDisconnectedError extends Error {
	constructor(message = "Pi client is disconnected", cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PiDisconnectedError";
	}
}

export class PiClientDisposedError extends Error {
	constructor() {
		super("Pi client is disposed");
		this.name = "PiClientDisposedError";
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): PiDisconnectedError {
	const cause = toError(error);
	return cause instanceof PiDisconnectedError ? cause : new PiDisconnectedError(cause.message, cause);
}

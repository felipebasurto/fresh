import type { ProtocolErrorCode } from "@earendil-works/pi-protocol";

type PiServerOperationErrorCode = Extract<ProtocolErrorCode, "wrong_server" | "session_not_found" | "server_draining">;

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";

/** A host or lifecycle error that can safely cross the protocol boundary. */
export class PiServerError extends Error {
	readonly code: PiServerOperationErrorCode;

	constructor(code: PiServerOperationErrorCode, message: string) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
	}
}

export class WrongServerError extends PiServerError {
	constructor() {
		super("wrong_server", "Request was addressed to another server");
		this.name = "WrongServerError";
	}
}

export class SessionNotFoundError extends PiServerError {
	constructor(message = "Session was not found") {
		super("session_not_found", message);
		this.name = "SessionNotFoundError";
	}
}

export class ServerDrainingError extends PiServerError {
	constructor() {
		super("server_draining", "Server is draining");
		this.name = "ServerDrainingError";
	}
}

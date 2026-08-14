import type { JsonValue, ProtocolErrorCode } from "@earendil-works/pi-protocol";

export type PiServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	"wrong_service" | "session_not_found" | "session_locked" | "server_busy" | "server_draining" | "invalid_request"
>;

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";

/** A host or lifecycle error that can safely cross the protocol boundary. */
export class PiServerError extends Error {
	readonly code: PiServerOperationErrorCode;
	readonly details: JsonValue | undefined;

	constructor(code: PiServerOperationErrorCode, message: string, details?: JsonValue) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
		this.details = details;
	}
}

export class WrongServiceError extends PiServerError {
	constructor() {
		super("wrong_service", "Request was addressed to another service");
		this.name = "WrongServiceError";
	}
}

export class SessionLockedError extends PiServerError {
	constructor(message = "Session is locked", details?: JsonValue) {
		super("session_locked", message, details);
		this.name = "SessionLockedError";
	}
}

export class SessionNotFoundError extends PiServerError {
	constructor(message = "Session was not found", details?: JsonValue) {
		super("session_not_found", message, details);
		this.name = "SessionNotFoundError";
	}
}

export class ServerBusyError extends PiServerError {
	constructor(message = "Server is busy", details?: JsonValue) {
		super("server_busy", message, details);
		this.name = "ServerBusyError";
	}
}

export class ServerDrainingError extends PiServerError {
	constructor() {
		super("server_draining", "Server is draining");
		this.name = "ServerDrainingError";
	}
}

/** An unsafe failure whose cause is retained for reporting but never serialized. */
export class InternalServerError extends Error {
	constructor(cause: unknown) {
		super(INTERNAL_SERVER_ERROR_MESSAGE, { cause });
		this.name = "InternalServerError";
	}
}

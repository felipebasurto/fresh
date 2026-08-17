import type { ProtocolErrorCode } from "@earendil-works/pi-protocol";

type PiServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	| "wrong_server"
	| "session_not_found"
	| "session_ambiguous"
	| "session_in_use"
	| "session_not_attached"
	| "watch_not_found"
	| "watch_in_use"
	| "not_supported"
	| "server_draining"
>;

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

export class SessionAmbiguousError extends PiServerError {
	constructor() {
		super("session_ambiguous", "Session ID matches more than one session");
		this.name = "SessionAmbiguousError";
	}
}

export class SessionInUseError extends PiServerError {
	constructor() {
		super("session_in_use", "Session is attached to another client");
		this.name = "SessionInUseError";
	}
}

export class SessionNotAttachedError extends PiServerError {
	constructor() {
		super("session_not_attached", "Session is not attached to this client");
		this.name = "SessionNotAttachedError";
	}
}

export class WatchNotFoundError extends PiServerError {
	constructor() {
		super("watch_not_found", "Lane watch was not found");
		this.name = "WatchNotFoundError";
	}
}

export class WatchInUseError extends PiServerError {
	constructor() {
		super("watch_in_use", "Session attachment already has a lane watch");
		this.name = "WatchInUseError";
	}
}

export class NotSupportedError extends PiServerError {
	constructor(message: string) {
		super("not_supported", message);
		this.name = "NotSupportedError";
	}
}

export class ServerDrainingError extends PiServerError {
	constructor() {
		super("server_draining", "Server is draining");
		this.name = "ServerDrainingError";
	}
}

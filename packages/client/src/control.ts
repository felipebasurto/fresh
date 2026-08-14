import {
	createRpcClient,
	encodeClientMessage,
	isServerId,
	ProtocolValidationError,
	ServerControlRpc,
	type ServerControlRpcCall,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { PiDisconnectedError, PiServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type { ByteTransportFactory } from "./transport.ts";

const DEFAULT_SERVER_CONTROL_TIMEOUT_MS = 15_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ServerControlOptions {
	readonly transportFactory: ByteTransportFactory;
	/** Logical server identity expected at the physical endpoint. */
	readonly serverId: string;
	readonly maxFrameLength?: number;
	/** Total time allowed for handshake and drain acknowledgement. Defaults to 15 seconds. */
	readonly timeoutMs?: number;
}

export class ServerControlTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Server control timed out after ${timeoutMs} ms`);
		this.name = "ServerControlTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

interface PendingControlRequest {
	readonly id: string;
	resolve(result: unknown): void;
	reject(error: Error): void;
}

/**
 * Ask one server generation to drain and wait for its acknowledgement.
 * Physical endpoint shutdown is transport-specific launcher policy.
 */
export async function requestServerDrain(options: ServerControlOptions): Promise<void> {
	if (!isServerId(options.serverId)) {
		throw new TypeError("Server control serverId must be a canonical lowercase UUIDv4");
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_CONTROL_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new TypeError(`Server control timeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}

	let pending: PendingControlRequest | undefined;
	const connection = new Connection({
		transportFactory: options.transportFactory,
		serverId: options.serverId,
		maxFrameLength: options.maxFrameLength,
		onHandshake: () => {},
		onMessage: (message) => {
			if (!pending || message.id !== pending.id) {
				connection.fail(new ProtocolValidationError("Control response has no matching request"));
				return;
			}
			const request = pending;
			pending = undefined;
			if (message.ok) request.resolve(message.result);
			else request.reject(new PiServerError(message.error));
		},
		onStateChange: (change) => {
			if (change.state !== "disconnected") return;
			const request = pending;
			pending = undefined;
			request?.reject(change.error ?? new PiDisconnectedError());
		},
	});
	const control = createRpcClient(
		ServerControlRpc,
		(call) =>
			sendControlRequest(connection, options.serverId, call, (request) => {
				pending = request;
			}),
		(message) => new ProtocolValidationError(message),
	);

	const timeout = setTimeout(() => {
		connection.disconnect(new ServerControlTimeoutError(timeoutMs));
	}, timeoutMs);
	timeout.unref();

	try {
		await connection.connect();
		await control.drain();
	} finally {
		clearTimeout(timeout);
		const request = pending;
		pending = undefined;
		request?.reject(new PiDisconnectedError("Server control client closed"));
		connection.disconnect("Server control client closed");
	}
}

function sendControlRequest(
	connection: Connection,
	serverId: string,
	call: ServerControlRpcCall,
	setPending: (request: PendingControlRequest) => void,
): Promise<unknown> {
	const id = "control-1";
	const { promise, resolve, reject } = createPromiseResolvers<unknown>();
	setPending({ id, resolve, reject });
	let frame: Uint8Array;
	try {
		frame = encodeClientMessage(
			{ type: "request", id, serverId, call },
			{ maxFrameLength: connection.maxFrameLength },
		);
	} catch (error) {
		reject(toError(error));
		return promise;
	}
	connection.send(frame);
	return promise;
}

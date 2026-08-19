import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
	type ClientMessage,
	encodeClientMessage,
	isJsonValue,
	PROTOCOL_VERSION,
	type ProtocolRpcCall,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { Deferred } from "./host.ts";

interface TestRpcCall {
	readonly method: string;
	readonly args: unknown;
}

interface MessageWaiter {
	predicate: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
}

export interface WireChannel {
	send(chunk: Uint8Array): Promise<void>;
	sendFragmented(chunk: Uint8Array, splitAt: number): Promise<void>;
	close(): Promise<void>;
}

export class ProtocolTestClient {
	readonly messages: ServerMessage[] = [];
	private readonly channel: WireChannel;
	private readonly decoder = new ServerMessageDecoder();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly closedDeferred = new Deferred<void>();
	private requestSequence = 0;
	private attachment: { sessionId: string; attachmentId: string } | undefined;
	private closedValue = false;

	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	hello(version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		const response = this.next((message) => message.type === "hello" || message.type === "hello_error");
		void this.sendMessage({ type: "hello", version });
		return response;
	}

	async request(
		serverId: string,
		call: TestRpcCall,
		id = `request-${++this.requestSequence}`,
	): Promise<ResponseEnvelope> {
		const response = this.next(
			(message): message is ResponseEnvelope => message.type === "response" && message.id === id,
		);
		const routed = this.routeLegacyCall(serverId, call);
		await this.sendMessage({ type: "request", id, ...routed });
		const received = (await response) as ResponseEnvelope;
		if (
			call.method === "attach" &&
			received.ok &&
			typeof received.result === "object" &&
			received.result !== null &&
			"sessionId" in received.result &&
			"attachmentId" in received.result &&
			typeof received.result.sessionId === "string" &&
			typeof received.result.attachmentId === "string"
		) {
			this.attachment = {
				sessionId: received.result.sessionId,
				attachmentId: received.result.attachmentId,
			};
		}
		return received;
	}

	sendMessage(message: ClientMessage): Promise<void> {
		return this.channel.send(encodeClientMessage(message));
	}

	private routeLegacyCall(serverId: string, call: TestRpcCall): { target: RpcTarget; call: ProtocolRpcCall } {
		if (!Array.isArray(call.args) || !call.args.every(isJsonValue)) {
			throw new Error(`Test call ${call.method} requires JSON array arguments`);
		}
		const sessionOperation = ["prompt", "watch", "startWatch", "stopWatch"].includes(call.method);
		let target: RpcTarget = { serverId };
		let args = call.args;
		if (sessionOperation) {
			if (typeof call.args[0] !== "string") throw new Error(`Test call ${call.method} requires a Session ID`);
			const sessionId = call.args[0];
			const attachment = this.attachment;
			target =
				attachment === undefined || attachment.sessionId !== sessionId
					? { serverId, sessionId, attachmentId: "missing-attachment" }
					: { serverId, ...attachment };
			args = call.args.slice(1);
		}
		const address = serviceAddress(call.method);
		return { target, call: { ...address, args } };
	}

	sendBytes(chunk: Uint8Array): Promise<void> {
		return this.channel.send(chunk);
	}

	sendFragmentedMessage(message: ClientMessage, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessage(message), splitAt);
	}

	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		return this.nextFrom(0, predicate);
	}

	nextFrom(index: number, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.slice(index).find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	close(): Promise<void> {
		return this.channel.close();
	}

	receive(chunk: Uint8Array): void {
		try {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

function serviceAddress(method: string): { serviceId: string; member: string } {
	switch (method) {
		case "list":
			return { serviceId: "session-directory", member: "list" };
		case "create":
		case "attach":
			return { serviceId: "session-management", member: method };
		case "prompt":
			return { serviceId: "chat", member: "prompt" };
		case "watch":
		case "startWatch":
		case "stopWatch":
			return { serviceId: "transcript", member: method };
		default:
			return { serviceId: "unknown", member: method };
	}
}

export async function connectUnixTestClient(path: string): Promise<ProtocolTestClient> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new ProtocolTestClient({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => {
		client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	});
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

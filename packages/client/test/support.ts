import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportHandlers } from "../src/index.ts";

export class MemoryByteServer {
	readonly messages: ClientMessage[] = [];
	readonly serviceId: string;
	private handlers?: ByteTransportHandlers;
	private decoder = new ClientMessageDecoder();

	constructor(serviceId = "service-1") {
		this.serviceId = serviceId;
	}

	connect(handlers: ByteTransportHandlers): ByteTransport {
		this.handlers = handlers;
		this.decoder = new ClientMessageDecoder();
		return {
			send: async (chunk) => {
				for (const message of this.decoder.push(chunk)) {
					this.messages.push(message);
					if (message.type === "hello") {
						this.send({
							type: "hello",
							version: PROTOCOL_VERSION,
							connectionId: "connection-1",
							serviceId: this.serviceId,
						});
					}
				}
			},
			close: () => {},
		};
	}

	send(message: ServerMessage): void {
		if (!this.handlers) throw new Error("No client connection");
		this.handlers.onData(encodeServerMessage(message));
	}

	disconnect(): void {
		this.handlers?.onClose();
		this.handlers = undefined;
	}
}

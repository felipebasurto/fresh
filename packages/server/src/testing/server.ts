import { PiServer } from "../server.ts";
import type { PiServerHost, PiServerOptions } from "../types.ts";
import { TestServerHost } from "./host.ts";

export interface TestServerOptions extends Omit<PiServerOptions, "serviceId"> {
	host?: PiServerHost;
	serviceId?: string;
}

export interface TestServer {
	server: PiServer;
	host: PiServerHost;
}

/** Create an unstarted PiServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const host = options.host ?? new TestServerHost();
	return {
		server: new PiServer(host, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serviceId: options.serviceId ?? "00000000000000000000000000000001",
			onError: options.onError,
		}),
		host,
	};
}

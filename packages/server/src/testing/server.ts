import { PiServer } from "../server.ts";
import type { PiServerHost, PiServerOptions } from "../types.ts";
import { TestServerHost } from "./host.ts";

export interface TestServerOptions extends Omit<PiServerOptions, "serverId"> {
	host?: PiServerHost;
	serverId?: string;
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
			serverId: options.serverId ?? "00000000-0000-4000-8000-000000000001",
			onError: options.onError,
		}),
		host,
	};
}

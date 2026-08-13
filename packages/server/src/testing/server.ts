import { PiServer } from "../server.ts";
import type { PiServerOptions, PiServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends Omit<PiServerOptions, "serviceId"> {
	service?: PiServerService;
	serviceId?: string;
}

export interface TestServer {
	server: PiServer;
	service: PiServerService;
}

/** Create an unstarted PiServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new PiServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serviceId: options.serviceId ?? "test-service",
			onError: options.onError,
		}),
		service,
	};
}

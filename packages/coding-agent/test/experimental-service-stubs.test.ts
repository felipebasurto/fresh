import { BACKGROUND_CONTEXT, RemoteServiceProvider, ServiceSliceNotImplemented } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { BUILTIN_SERVER_SERVICES, BUILTIN_SESSION_SERVICES } from "../src/experimental/services/builtins.ts";
import { provideBuiltinServiceStubs } from "../src/experimental/services/stubs-provider.ts";

describe("experimental built-in service surface", () => {
	test("inventories every built-in server and Session service", () => {
		expect(BUILTIN_SERVER_SERVICES.map(({ id }) => id)).toEqual(["pi.session-directory", "pi.session-management"]);
		expect(BUILTIN_SESSION_SERVICES.map(({ id }) => id)).toEqual([
			"pi.accounts",
			"pi.chat",
			"pi.models",
			"pi.transcript",
		]);
	});

	test("exposes later singleton slices as explicit unimplemented providers", async () => {
		const provider = new RemoteServiceProvider(BUILTIN_SESSION_SERVICES);
		provideBuiltinServiceStubs(provider);
		try {
			const accounts = provider.subscribe("pi.accounts", "singleton", () => {}).snapshot;
			expect(accounts.instances[0]?.states.state?.value).toEqual({ providers: [] });
			await expect(
				provider.invoke({ serviceId: "pi.accounts", member: "remove", args: ["anthropic"] }, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);

			const transcript = provider.subscribe("pi.transcript", "singleton", () => {}).snapshot;
			expect(transcript.instances[0]?.members).toEqual([
				{ name: "events", kind: "events" },
				{ name: "snapshot", kind: "method" },
			]);
			await expect(
				provider.invoke({ serviceId: "pi.transcript", member: "snapshot", args: [] }, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);
		} finally {
			provider.dispose();
		}
	});
});

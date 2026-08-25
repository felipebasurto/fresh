import { BACKGROUND_CONTEXT, ServiceSliceNotImplemented } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { createFacetHost } from "../src/experimental/facets.ts";
import { accountsServiceFacet, transcriptServiceFacet } from "../src/experimental/services/stubs-provider.ts";

describe("experimental built-in service surface", () => {
	test("exposes later singleton slices as explicit unimplemented providers", async () => {
		const host = await createFacetHost({ facets: [accountsServiceFacet, transcriptServiceFacet] });
		try {
			const accounts = host.services.subscribe("pi.accounts", "singleton", () => {}).snapshot;
			expect(accounts.instances[0]?.states.state?.value).toEqual({ providers: [] });
			await expect(
				host.services.invoke(
					{ serviceId: "pi.accounts", member: "remove", args: ["anthropic"] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);

			const transcript = host.services.subscribe("pi.transcript", "singleton", () => {}).snapshot;
			expect(transcript.instances[0]?.members).toEqual([
				{ name: "events", kind: "events" },
				{ name: "snapshot", kind: "method" },
			]);
			await expect(
				host.services.invoke({ serviceId: "pi.transcript", member: "snapshot", args: [] }, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);
		} finally {
			await host.dispose();
		}
	});
});

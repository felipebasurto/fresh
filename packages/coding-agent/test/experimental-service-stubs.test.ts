import { BACKGROUND_CONTEXT, createFacetHost } from "@earendil-works/chord";
import { describe, expect, test } from "vitest";
import {
	accountsServiceFacet,
	ServiceSliceNotImplemented,
	transcriptServiceFacet,
} from "../src/experimental/services/stubs-provider.ts";

describe("experimental built-in service surface", () => {
	test("exposes later singleton slices as explicit unimplemented providers", async () => {
		const host = await createFacetHost({ facets: [accountsServiceFacet, transcriptServiceFacet] });
		try {
			const accounts = host.services.subscribe("pi.accounts", "singleton", () => {}).snapshot;
			expect(accounts.instances[0]?.members).toContainEqual({
				name: "state",
				kind: "state",
				sequence: 0,
				value: { providers: [] },
			});
			await expect(
				host.services.invoke(
					{ serviceId: "pi.accounts", member: "remove", args: ["anthropic"] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);

			await expect(
				host.services.invoke({ serviceId: "pi.transcript", member: "snapshot", args: [] }, BACKGROUND_CONTEXT),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);
		} finally {
			await host.dispose();
		}
	});
});

import { ServiceSliceNotImplemented } from "@earendil-works/pi-agent-core";
import { defineFacet } from "../facets.ts";
import { Accounts, type AccountsState } from "./accounts.ts";
import { Transcript } from "./transcript.ts";

/** Documented built-in surfaces whose implementations belong to later service slices. */
export const accountsServiceFacet = defineFacet({
	id: "@pi/accounts",
	setup(env) {
		env.provide(Accounts, {
			state: env.replicatedState<AccountsState>({ providers: [] }),
			async remove() {
				throw new ServiceSliceNotImplemented("Accounts.remove");
			},
		});
	},
});

export const transcriptServiceFacet = defineFacet({
	id: "@pi/transcript",
	setup(env) {
		env.provide(Transcript, {
			async snapshot() {
				throw new ServiceSliceNotImplemented("Transcript.snapshot");
			},
		});
	},
});

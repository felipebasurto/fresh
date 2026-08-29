import { defineFacet } from "@earendil-works/chord";
import { Accounts, type AccountsState } from "./accounts.ts";
import { Transcript } from "./transcript.ts";

export class ServiceSliceNotImplemented extends Error {
	readonly code = "service_not_implemented" as const;

	constructor(operation: string) {
		super(`${operation} is not implemented until its later facet-service slice`);
		this.name = "ServiceSliceNotImplemented";
	}
}

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

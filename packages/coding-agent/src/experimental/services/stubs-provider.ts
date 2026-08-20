import {
	type RemoteServiceProvider,
	remoteEvents,
	remoteState,
	ServiceSliceNotImplemented,
} from "@earendil-works/pi-agent-core";
import { Accounts, type AccountsState } from "./accounts.ts";
import { Transcript, type TranscriptEvent } from "./transcript.ts";

/** Install documented built-in surfaces whose implementation belongs to later client/server slices. */
export function provideBuiltinServiceStubs(provider: RemoteServiceProvider): void {
	provider.provide(Accounts, {
		state: remoteState<AccountsState>({ providers: [] }),
		async remove() {
			throw new ServiceSliceNotImplemented("Accounts.remove");
		},
	});
	provider.provide(Transcript, {
		events: remoteEvents<TranscriptEvent>(),
		async snapshot() {
			throw new ServiceSliceNotImplemented("Transcript.snapshot");
		},
	});
}

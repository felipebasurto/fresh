import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExampleFacetService } from "./contract.ts";

export default defineFacet({
	id: "@earendil-works/pi-example-plugin/session",
	setup(env) {
		const workerActivations = env.replicatedState(0);
		env.provide(ExampleFacetService, {
			workerActivations,
			async greet({ name }) {
				return {
					message: `Hello ${name} from the bundled Session worker facet!!!`,
					workerActivations: workerActivations.value,
				};
			},
		});
		env.onActivate(() => {
			workerActivations.set(workerActivations.value + 1, BACKGROUND_CONTEXT);
		});
	},
});

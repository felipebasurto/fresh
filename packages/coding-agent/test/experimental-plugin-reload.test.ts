import { defineFacet, type FacetLoader } from "@earendil-works/chord";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { createSessionWorkerServices } from "../src/experimental/services/worker.ts";

describe("experimental plugin reload", () => {
	test("loads and cuts over a fresh Session facet generation", async () => {
		const activations: number[] = [];
		const disposals: number[] = [];
		let generation = 0;
		const facetLoader: FacetLoader = {
			async load() {
				const current = ++generation;
				return {
					facets: [
						defineFacet({
							id: "reloadable-session-plugin",
							setup(env) {
								env.onActivate(() => {
									activations.push(current);
								});
							},
						}),
					],
					async dispose() {
						disposals.push(current);
					},
				};
			},
		};
		const lane = {
			async getModel() {
				return undefined;
			},
			async getThinkingLevel() {
				return "off" as const;
			},
		} as unknown as AgentLane;
		const services = await createSessionWorkerServices({
			lane,
			modelRuntime: undefined,
			facetLoader,
			publish: vi.fn(async () => {}),
		});
		try {
			expect(activations).toEqual([1]);
			await services.reload();
			expect(activations).toEqual([1, 2]);
			expect(disposals).toEqual([1]);
		} finally {
			await services.dispose();
		}
		expect(disposals).toEqual([1, 2]);
	});
});

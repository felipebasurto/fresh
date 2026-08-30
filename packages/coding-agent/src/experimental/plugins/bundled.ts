import { combineFacetLoaders, type FacetLoader } from "@earendil-works/chord";
import {
	createFacetBundleArtifactLoader,
	createFacetBundleLoader,
	type FacetBundleArtifact,
	readFacetBundleManifest,
} from "@earendil-works/chord/node";
import type { JsonValue } from "@earendil-works/pi-protocol";

const PRESENTATION_FACET_BUNDLES_KEY = "presentationFacetBundles";
const PI_PLUGIN_API = "@earendil-works/pi-coding-agent/experimental/plugin";

export function createConfiguredPluginFacetLoader(
	entry: "session",
	manifestPaths: readonly string[],
): FacetLoader | undefined {
	if (manifestPaths.length === 0) return undefined;
	return combineFacetLoaders(manifestPaths.map((manifestPath) => createOptionalFacetLoader(manifestPath, entry)));
}

function createOptionalFacetLoader(manifestPath: string, entry: "session"): FacetLoader {
	const loader = createFacetBundleLoader({
		manifestPath,
		entry,
		resolveExternal: resolvePluginExternal,
	});
	return {
		async load() {
			const manifest = await readFacetBundleManifest(manifestPath);
			if (manifest.entries[entry] !== undefined) return loader.load();
			return { facets: Object.freeze([]), async dispose() {} };
		},
	};
}

export function createPresentationFacetHelloData(artifacts: readonly FacetBundleArtifact[]): JsonValue | undefined {
	if (artifacts.length === 0) return undefined;
	return createPresentationFacetData(artifacts);
}

export function createPresentationFacetData(artifacts: readonly FacetBundleArtifact[]): JsonValue {
	return {
		[PRESENTATION_FACET_BUNDLES_KEY]: artifacts.map((artifact) => artifact as unknown as JsonValue),
	};
}

/** Create local loaders only from artifacts selected and sent by the connected server. */
export function createPresentationFacetLoaders(data: JsonValue | undefined): readonly FacetLoader[] {
	if (data === undefined) return [];
	if (data === null || Array.isArray(data) || typeof data !== "object") {
		throw new Error("Invalid experimental server hello data");
	}
	const artifacts = data[PRESENTATION_FACET_BUNDLES_KEY];
	if (artifacts === undefined) return [];
	if (!Array.isArray(artifacts)) throw new Error("Invalid presentation facet bundle list in server hello");
	return artifacts.map((artifact) =>
		createFacetBundleArtifactLoader({ artifact, resolveExternal: resolvePluginExternal }),
	);
}

function resolvePluginExternal(specifier: string): string | undefined {
	return specifier === PI_PLUGIN_API ? import.meta.resolve(specifier) : undefined;
}

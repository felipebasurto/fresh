import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FacetLoader } from "@earendil-works/chord";
import {
	createFacetBundleArtifactLoader,
	createFacetBundleLoader,
	type FacetBundleArtifact,
	readFacetBundleArtifact,
} from "@earendil-works/chord/node";
import type { JsonValue, ServerId } from "@earendil-works/pi-protocol";

const FACET_BUNDLE_ENV = "PI_EXPERIMENTAL_FACET_BUNDLE";
const FACET_BUNDLE_PROFILE_VERSION = 1;
const PRESENTATION_FACET_BUNDLES_KEY = "presentationFacetBundles";

export function createConfiguredFacetBundleLoader(entry: "session"): FacetLoader | undefined {
	const manifestPath = process.env[FACET_BUNDLE_ENV];
	if (manifestPath === undefined || manifestPath.length === 0) return undefined;
	return createFacetBundleLoader({ manifestPath, entry });
}

/** Persist an explicit bundle selection and restore it for later server generations. */
export async function restoreServerFacetBundleProfile(directory: string, serverId: ServerId): Promise<void> {
	const path = join(directory, `facet-bundle-${serverId}.json`);
	const configured = process.env[FACET_BUNDLE_ENV];
	if (configured !== undefined) {
		if (configured.length === 0) {
			await rm(path, { force: true });
			return;
		}
		const manifestPath = resolve(configured);
		await writeFile(path, `${JSON.stringify({ version: FACET_BUNDLE_PROFILE_VERSION, manifestPath }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		process.env[FACET_BUNDLE_ENV] = manifestPath;
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw new Error(`Could not read experimental facet bundle profile ${path}`, { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some((key) => key !== "version" && key !== "manifestPath") ||
		!("version" in parsed) ||
		parsed.version !== FACET_BUNDLE_PROFILE_VERSION ||
		!("manifestPath" in parsed) ||
		typeof parsed.manifestPath !== "string" ||
		parsed.manifestPath.length === 0
	) {
		throw new Error(`Invalid experimental facet bundle profile ${path}`);
	}
	process.env[FACET_BUNDLE_ENV] = parsed.manifestPath;
}

/** Read presentation facets on the server so their selection and contents can be sent during the handshake. */
export async function readConfiguredPresentationFacetBundles(): Promise<readonly FacetBundleArtifact[]> {
	const manifestPath = process.env[FACET_BUNDLE_ENV];
	if (manifestPath === undefined || manifestPath.length === 0) return [];
	return [await readFacetBundleArtifact({ manifestPath, entry: "tui" })];
}

export function createPresentationFacetHelloData(artifacts: readonly FacetBundleArtifact[]): JsonValue | undefined {
	if (artifacts.length === 0) return undefined;
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
	return artifacts.map((artifact) => createFacetBundleArtifactLoader({ artifact }));
}

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { bundleFacetPackage } from "@earendil-works/chord/bundler";
import {
	FACET_BUNDLE_MANIFEST_FILE,
	type FacetBundleArtifact,
	readFacetBundleArtifact,
} from "@earendil-works/chord/node";
import type { ServerId } from "@earendil-works/pi-protocol";

const PLUGIN_PACKAGE_PROFILE_VERSION = 1;
const SESSION_PLUGIN_PACKAGE_PROFILE_VERSION = 1;
const DEFAULT_PLUGIN_FACETS = Object.freeze({ session: "src/session.ts", tui: "src/tui.ts" });

export interface ConfiguredServerPluginPackage {
	readonly packagePath: string;
	readonly manifestPath: string;
	build(): Promise<readonly FacetBundleArtifact[]>;
}

/** Persist an explicit plugin package selection or restore it for a later server generation. */
export async function restoreServerPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	configuredPackagePaths?: readonly string[],
): Promise<readonly string[]> {
	const path = join(directory, `plugin-packages-${serverId}.json`);
	if (configuredPackagePaths !== undefined) {
		const packagePaths = normalizePluginPackagePaths(configuredPackagePaths);
		if (packagePaths.length === 0) {
			await rm(path, { force: true });
			return packagePaths;
		}
		await writeFile(path, `${JSON.stringify({ version: PLUGIN_PACKAGE_PROFILE_VERSION, packagePaths }, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return packagePaths;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw new Error(`Could not read experimental plugin package profile ${path}`, { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some((key) => key !== "version" && key !== "packagePaths") ||
		!("version" in parsed) ||
		parsed.version !== PLUGIN_PACKAGE_PROFILE_VERSION ||
		!("packagePaths" in parsed) ||
		!Array.isArray(parsed.packagePaths) ||
		parsed.packagePaths.length === 0 ||
		parsed.packagePaths.some((packagePath) => typeof packagePath !== "string" || packagePath.length === 0)
	) {
		throw new Error(`Invalid experimental plugin package profile ${path}`);
	}
	return normalizePluginPackagePaths(parsed.packagePaths as readonly string[]);
}

/** Read the explicit plugin selection stored for one durable Session. */
export async function readSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
): Promise<readonly string[] | undefined> {
	const path = sessionPluginProfilePath(directory, serverId, sessionPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read experimental Session plugin profile ${path}`, { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some((key) => key !== "version" && key !== "sessionPath" && key !== "packagePaths") ||
		!("version" in parsed) ||
		parsed.version !== SESSION_PLUGIN_PACKAGE_PROFILE_VERSION ||
		!("sessionPath" in parsed) ||
		parsed.sessionPath !== sessionPath ||
		!("packagePaths" in parsed) ||
		!Array.isArray(parsed.packagePaths) ||
		parsed.packagePaths.some((packagePath) => typeof packagePath !== "string" || packagePath.length === 0)
	) {
		throw new Error(`Invalid experimental Session plugin profile ${path}`);
	}
	return normalizePluginPackagePaths(parsed.packagePaths as readonly string[]);
}

/** Remove the plugin selection stored for one deleted Session. */
export async function removeSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
): Promise<void> {
	await rm(sessionPluginProfilePath(directory, serverId, sessionPath), { force: true });
}

/** Persist the plugin selection for one durable Session. */
export async function writeSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
	packagePaths: readonly string[],
): Promise<void> {
	const normalized = normalizePluginPackagePaths(packagePaths);
	const path = sessionPluginProfilePath(directory, serverId, sessionPath);
	await writeFile(
		path,
		`${JSON.stringify(
			{ version: SESSION_PLUGIN_PACKAGE_PROFILE_VERSION, sessionPath, packagePaths: normalized },
			null,
			2,
		)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/** Create a serialized server-owned builder for one configured plugin package. */
export function createServerPluginPackage(
	directory: string,
	serverId: ServerId,
	packagePath: string,
): ConfiguredServerPluginPackage {
	const normalizedPackagePath = resolve(packagePath);
	const outdir = join(directory, "plugin-builds", serverId, pluginBuildDirectoryName(normalizedPackagePath));
	const manifestPath = join(outdir, FACET_BUNDLE_MANIFEST_FILE);
	let buildTail = Promise.resolve();
	return {
		packagePath: normalizedPackagePath,
		manifestPath,
		build() {
			const operation = buildTail.then(async () => {
				const result = await bundleFacetPackage({
					packagePath: normalizedPackagePath,
					outdir,
					defaultFacets: DEFAULT_PLUGIN_FACETS,
				});
				if (result.manifest.entries.tui === undefined) return [];
				return [await readFacetBundleArtifact({ manifestPath: result.manifestPath, entry: "tui" })];
			});
			buildTail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	};
}

export function normalizePluginPackagePaths(packagePaths: readonly string[]): readonly string[] {
	const normalized = packagePaths.map((packagePath) => {
		if (packagePath.length === 0) throw new Error("Plugin package path must not be empty");
		return resolve(packagePath);
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("Plugin package paths must be unique");
	}
	return Object.freeze(normalized);
}

function sessionPluginProfilePath(directory: string, serverId: ServerId, sessionPath: string): string {
	const hash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
	return join(directory, `session-plugin-packages-${serverId}-${hash}.json`);
}

function pluginBuildDirectoryName(packagePath: string): string {
	const packageDirectory = basename(packagePath) === "package.json" ? dirname(packagePath) : packagePath;
	const base = basename(packageDirectory).replaceAll(/[^a-zA-Z0-9._-]/gu, "-") || "plugin";
	const label = base.endsWith("-plugin") ? base : `${base}-plugin`;
	const hash = createHash("sha256").update(packagePath).digest("hex").slice(0, 12);
	return `${label}-${hash}`;
}

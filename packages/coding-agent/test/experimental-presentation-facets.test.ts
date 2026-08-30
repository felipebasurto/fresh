import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	FACET_BUNDLE_ARTIFACT_FORMAT,
	FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
	type FacetBundleArtifact,
} from "@earendil-works/chord/node";
import { TestServerHost } from "@earendil-works/pi-server/testing";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { afterEach, describe, expect, test } from "vitest";
import { type ClientRuntime, openClientRuntime } from "../src/experimental/client-runtime.ts";
import {
	createPresentationFacetHelloData,
	restoreServerFacetBundleProfile,
} from "../src/experimental/plugins/bundled.ts";

const runtimes = new Set<ClientRuntime>();
const servers = new Set<ReturnType<typeof createUnixServer>>();
const directories = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
	await Promise.allSettled([...servers].map((server) => server.close()));
	await Promise.allSettled([...directories].map((directory) => rm(directory, { force: true, recursive: true })));
	runtimes.clear();
	servers.clear();
	directories.clear();
});

describe("server-selected presentation facets", () => {
	test("restores the bundle selection for later server generations", async () => {
		const directory = await mkdtemp("/tmp/pi-presentation-profile-");
		directories.add(directory);
		const serverId = randomUUID();
		const manifestPath = join(directory, "facets", "chord-facets.json");
		const original = process.env.PI_EXPERIMENTAL_FACET_BUNDLE;
		try {
			process.env.PI_EXPERIMENTAL_FACET_BUNDLE = manifestPath;
			await restoreServerFacetBundleProfile(directory, serverId);

			delete process.env.PI_EXPERIMENTAL_FACET_BUNDLE;
			await restoreServerFacetBundleProfile(directory, serverId);
			expect(process.env.PI_EXPERIMENTAL_FACET_BUNDLE).toBe(manifestPath);

			process.env.PI_EXPERIMENTAL_FACET_BUNDLE = "";
			await restoreServerFacetBundleProfile(directory, serverId);
			delete process.env.PI_EXPERIMENTAL_FACET_BUNDLE;
			await restoreServerFacetBundleProfile(directory, serverId);
			expect(process.env.PI_EXPERIMENTAL_FACET_BUNDLE).toBeUndefined();
		} finally {
			if (original === undefined) delete process.env.PI_EXPERIMENTAL_FACET_BUNDLE;
			else process.env.PI_EXPERIMENTAL_FACET_BUNDLE = original;
		}
	});

	test("receives and loads a TUI facet without client-side plugin configuration", async () => {
		const source =
			'import { defineFacet } from "@earendil-works/chord";\nexport default defineFacet({ id: "server-selected-tui", setup() {} });\n';
		const artifact: FacetBundleArtifact = {
			format: FACET_BUNDLE_ARTIFACT_FORMAT,
			formatVersion: FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
			plugin: { id: "server-selected-plugin" },
			entryName: "tui",
			entry: {
				file: "tui.js",
				integrity: `sha256-${createHash("sha256").update(source).digest("base64")}`,
				externalImports: ["@earendil-works/chord"],
			},
			source,
		};
		const directory = await mkdtemp("/tmp/pi-presentation-facet-");
		directories.add(directory);
		const serverId = randomUUID();
		const socketPath = join(directory, `${serverId}.sock`);
		const server = createUnixServer(new TestServerHost(), {
			path: socketPath,
			serverId,
			helloData: createPresentationFacetHelloData([artifact]),
		});
		servers.add(server);
		await server.start();

		const runtime = await openClientRuntime({
			command: "client",
			connect: { transport: "unix", path: socketPath },
		});
		runtimes.add(runtime);
		expect(runtime.servers[0]?.presentationFacetLoaders).toHaveLength(1);

		const loaded = await runtime.servers[0]!.presentationFacetLoaders[0]!.load();
		try {
			expect(loaded.facets.map(({ id }) => id)).toEqual(["server-selected-tui"]);
		} finally {
			await loaded.dispose();
		}
	});
});

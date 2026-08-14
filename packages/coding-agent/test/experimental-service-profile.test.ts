import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireExperimentalServiceProfile } from "../src/cli/experimental/service-profile.ts";

const directories = new Set<string>();

async function makeDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "psp-"));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental service profile", () => {
	test("serializes launchers and preserves the service identity", async () => {
		const directory = await makeDirectory();
		const first = await acquireExperimentalServiceProfile(directory);
		let secondAcquired = false;
		const pendingSecond = acquireExperimentalServiceProfile(directory).then((profile) => {
			secondAcquired = true;
			return profile;
		});

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondAcquired).toBe(false);
		await first.release();

		const second = await pendingSecond;
		expect(secondAcquired).toBe(true);
		expect(second.serviceId).toBe(first.serviceId);
		await second.release();
	});

	test("does not serialize or share identity across service directories", async () => {
		const firstDirectory = await makeDirectory();
		const secondDirectory = await makeDirectory();

		const [first, second] = await Promise.all([
			acquireExperimentalServiceProfile(firstDirectory),
			acquireExperimentalServiceProfile(secondDirectory),
		]);
		expect(first.serviceId).not.toBe(second.serviceId);
		await Promise.all([first.release(), second.release()]);
	});

	test("rejects corrupt identity and releases the launcher lock", async () => {
		const directory = await makeDirectory();
		await writeFile(join(directory, "service-id"), "invalid\n");

		await expect(acquireExperimentalServiceProfile(directory)).rejects.toThrow(
			/Invalid experimental service identity/,
		);
		await expect(access(join(directory, ".launcher.lock"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

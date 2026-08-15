import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveExperimentalSessionDirectory } from "../src/cli/experimental/runtime.ts";

afterEach(() => vi.unstubAllEnvs());

describe("experimental server session directory", () => {
	test("uses the experimental directory under the configured agent directory by default", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent-config");

		expect(resolveExperimentalSessionDirectory()).toBe("/tmp/pi-agent-config/experimental/sessions");
	});

	test("resolves an explicit relative directory from the current working directory", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent-config");

		expect(resolveExperimentalSessionDirectory("relative/sessions")).toBe(resolve("relative/sessions"));
	});

	test("expands a tilde in an explicit directory", () => {
		expect(resolveExperimentalSessionDirectory("~/custom-sessions")).toBe(resolve(homedir(), "custom-sessions"));
	});
});

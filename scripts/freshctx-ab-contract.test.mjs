import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	evaluateTaskContract,
	extractToolCalls,
	selectTaskIds,
} from "./freshctx-ab-contract.mjs";
import { runSucceeded } from "./freshctx-ab-metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const t9Contract = JSON.parse(
	readFileSync(join(here, "../.freshctx-pilot/tasks/t9-frozen-region-file/contract.json"), "utf8"),
);

function sessionWithCalls(calls) {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				content: calls.map((call, i) => ({
					type: "toolCall",
					id: `call_${i}`,
					name: call.name,
					arguments: call.arguments,
				})),
			},
		},
	];
}

const validTrajectory = [
	{ name: "read", arguments: { path: "config.py", offset: 770, limit: 20 } },
	{
		name: "edit",
		arguments: {
			path: "config.py",
			edits: [{ oldText: "TARGET_RATE = 10  # BUG: should be 12", newText: "TARGET_RATE = 12" }],
		},
	},
];

describe("selectTaskIds", () => {
	it("returns all tasks when --task is omitted", () => {
		assert.deepEqual(selectTaskIds(["a", "b"], ""), ["a", "b"]);
	});

	it("selects a single known task", () => {
		assert.deepEqual(selectTaskIds(["a", "t9-frozen-region-file"], "t9-frozen-region-file"), [
			"t9-frozen-region-file",
		]);
	});

	it("rejects unknown task ids", () => {
		assert.throws(() => selectTaskIds(["a"], "missing"), /unknown task id: missing/);
	});
});

describe("t9 contract evaluation", () => {
	it("passes a bounded read + TARGET_RATE edit with verify PASS", () => {
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(validTrajectory), "PASS");
		assert.equal(result.ok, true);
		assert.deepEqual(result.failures, []);
	});

	it("rejects missing bounded read", () => {
		const calls = validTrajectory.filter((c) => c.name !== "read");
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(calls), "PASS");
		assert.equal(result.ok, false);
		assert.ok(result.failures.some((f) => f.startsWith("missing-read:")));
	});

	it("rejects full-file read of config.py", () => {
		const calls = [
			{ name: "read", arguments: { path: "config.py" } },
			...validTrajectory.filter((c) => c.name === "edit"),
		];
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(calls), "PASS");
		assert.equal(result.ok, false);
		assert.ok(result.failures.includes("full-file-read:config.py"));
	});

	it("rejects shell dump of config.py", () => {
		const calls = [
			...validTrajectory,
			{ name: "bash", arguments: { command: "cat config.py" } },
		];
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(calls), "PASS");
		assert.equal(result.ok, false);
		assert.ok(result.failures.includes("shell-file-dump"));
	});

	it("rejects missing TARGET_RATE edit", () => {
		const calls = validTrajectory.filter((c) => c.name !== "edit");
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(calls), "PASS");
		assert.equal(result.ok, false);
		assert.ok(result.failures.some((f) => f.startsWith("missing-edit:")));
	});

	it("rejects verify failure even when tools match", () => {
		const result = evaluateTaskContract(t9Contract, sessionWithCalls(validTrajectory), "FAIL");
		assert.equal(result.ok, false);
		assert.ok(result.failures.includes("verify:FAIL"));
	});

	it("extractToolCalls reads assistant toolCall blocks", () => {
		const calls = extractToolCalls(sessionWithCalls(validTrajectory));
		assert.equal(calls.length, 2);
		assert.equal(calls[0].name, "read");
		assert.equal(calls[0].arguments.offset, 770);
	});
});

describe("runSucceeded with contract", () => {
	it("fails when contractOk is false", () => {
		assert.equal(
			runSucceeded({
				verifyStatus: "PASS",
				timedOut: false,
				exitCode: 0,
				driftBlocked: 0,
				contractOk: false,
			}),
			false,
		);
	});
});

import { describe, expect, test } from "vitest";
import { cli } from "../src/cli/experimental/cli.ts";

describe("experimental CLI commands", () => {
	test("selects pi mode and parses existing CLI arguments", () => {
		expect(
			cli.parse([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--thinking",
				"high",
				"inspect",
				"the project",
			]),
		).toMatchObject({
			ok: true,
			command: {
				command: "pi",
				options: {
					provider: "anthropic",
					model: "claude-sonnet",
					thinking: "high",
					messages: ["inspect", "the project"],
				},
			},
		});
	});

	test("parses a server listener", () => {
		expect(cli.parse(["server", "--listen", "unix:///tmp/pi.sock"])).toEqual({
			ok: true,
			command: {
				command: "server",
				listen: [{ transport: "unix", path: "/tmp/pi.sock" }],
			},
		});
	});

	test("parses an experimental server ID", () => {
		expect(cli.parse(["server", "--server-id", "00000000-0000-4000-8000-000000000001"])).toEqual({
			ok: true,
			command: {
				command: "server",
				serverId: "00000000-0000-4000-8000-000000000001",
			},
		});
	});

	test("parses an experimental server session directory", () => {
		expect(cli.parse(["server", "--session-dir", "~/pi-sessions"])).toEqual({
			ok: true,
			command: {
				command: "server",
				sessionDir: "~/pi-sessions",
			},
		});
	});

	test("parses an experimental server model", () => {
		expect(cli.parse(["server", "--provider", "anthropic", "--model", "claude-sonnet-4-5"])).toEqual({
			ok: true,
			command: {
				command: "server",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		});
	});

	test("parses a provider-qualified server model", () => {
		expect(cli.parse(["server", "--model", "anthropic/claude-sonnet-4-5:high"])).toEqual({
			ok: true,
			command: {
				command: "server",
				model: "anthropic/claude-sonnet-4-5:high",
			},
		});
	});

	test("parses repeatable server plugin packages", () => {
		expect(cli.parse(["server", "-e", "./first-plugin", "-e=./second-plugin"])).toEqual({
			ok: true,
			command: {
				command: "server",
				pluginPackages: ["./first-plugin", "./second-plugin"],
			},
		});
	});

	test("leaves experimental-looking existing option values with the existing parser", () => {
		expect(cli.parse(["--system-prompt", "--listen", "unix:///tmp/pi.sock"])).toMatchObject({
			ok: true,
			command: {
				command: "pi",
				options: { systemPrompt: "--listen", messages: ["unix:///tmp/pi.sock"] },
			},
		});
	});

	test("stops parsing command options when existing CLI arguments begin", () => {
		const result = cli.parse(["--model", "claude-sonnet", "--listen=unix:///tmp/second.sock"]);
		expect(result).toMatchObject({
			ok: true,
			command: { command: "pi", options: { model: "claude-sonnet" } },
		});
		if (!result.ok || result.command.command !== "pi") return;
		expect(result.command.listen).toBeUndefined();
		expect(result.command.options.unknownFlags.get("listen")).toBe("unix:///tmp/second.sock");
	});

	test("parses client transport addresses", () => {
		expect(cli.parse(["client", "--connect", "unix:///tmp/pi.sock"])).toEqual({
			ok: true,
			command: {
				command: "client",
				connect: { transport: "unix", path: "/tmp/pi.sock" },
			},
		});
		expect(
			cli.parse(["client", "--connect", "radius://00000000-0000-4000-8000-000000000001", "--session-id", "demo-1"]),
		).toEqual({
			ok: true,
			command: {
				command: "client",
				connect: { transport: "radius", serverId: "00000000-0000-4000-8000-000000000001" },
				sessionId: "demo-1",
			},
		});
	});

	test.each([
		["-c", "continue"],
		["--continue", "continue"],
		["-r", "resume"],
		["--resume", "resume"],
	] as const)("parses client Session selection %s", (option, property) => {
		expect(cli.parse(["client", option])).toEqual({
			ok: true,
			command: { command: "client", [property]: true },
		});
	});

	test("parses a client session ID", () => {
		expect(cli.parse(["client", "--session-id", "demo-1"])).toEqual({
			ok: true,
			command: {
				command: "client",
				sessionId: "demo-1",
			},
		});
	});

	test("parses a one-shot client prompt without a session ID", () => {
		expect(cli.parse(["client", "Explain this project"])).toEqual({
			ok: true,
			command: {
				command: "client",
				prompt: "Explain this project",
			},
		});
	});

	test("parses the model used for cold client activation", () => {
		expect(cli.parse(["client", "--provider", "anthropic", "--model", "claude-sonnet-4-5"])).toEqual({
			ok: true,
			command: {
				command: "client",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		});
	});

	test("parses a provider-qualified model used for cold client activation", () => {
		expect(cli.parse(["client", "--model", "anthropic/claude-sonnet-4-5:high"])).toEqual({
			ok: true,
			command: {
				command: "client",
				model: "anthropic/claude-sonnet-4-5:high",
			},
		});
	});

	test("parses repeatable client plugin packages", () => {
		expect(cli.parse(["client", "-e", "./first-plugin", "-e", "./second-plugin"])).toEqual({
			ok: true,
			command: {
				command: "client",
				pluginPackages: ["./first-plugin", "./second-plugin"],
			},
		});
	});

	test.each([
		[["--auth-token", "secret"], { type: "token", token: "secret" }],
		[["--auth-token-file", "/tmp/token"], { type: "file", path: "/tmp/token" }],
	] as const)("parses authentication source %j", (argv, auth) => {
		expect(cli.parse(argv)).toMatchObject({
			ok: true,
			command: { command: "pi", auth },
		});
	});

	test.each([[[]], [["server"]], [["client"]]] as const)(
		"permits omitted authentication for later environment/default resolution",
		(argv) => {
			const result = cli.parse(argv);
			expect(result).toMatchObject({ ok: true, command: { command: argv[0] ?? "pi" } });
			if (result.ok) expect(result.command.auth).toBeUndefined();
		},
	);

	test("passes unknown options, file arguments, and the positional separator to the existing parser", () => {
		const result = cli.parse(["--unknown", "@prompt.md", "--", "--listen", "unix:///tmp/pi.sock"]);
		expect(result).toMatchObject({
			ok: true,
			command: {
				command: "pi",
				options: { fileArgs: ["prompt.md"], messages: ["--listen", "unix:///tmp/pi.sock"] },
			},
		});
		if (!result.ok || result.command.command !== "pi") return;
		expect(result.command.options.unknownFlags).toEqual(new Map([["unknown", true]]));
	});

	test.each([
		[
			["--listen", "unix:///tmp/pi.sock", "--listen", "unix:///tmp/pi-admin.sock"],
			"--listen may only be specified once",
		],
		[
			["--auth-token", "secret", "--auth-token-file", "/tmp/token"],
			"--auth-token and --auth-token-file are mutually exclusive",
		],
		[["--auth-token", "first", "--auth-token", "second"], "--auth-token may only be specified once"],
		[
			["--auth-token-file", "/tmp/first", "--auth-token-file=/tmp/second"],
			"--auth-token-file may only be specified once",
		],
		[["--listen", "/tmp/pi.sock"], 'Invalid --listen address "/tmp/pi.sock"'],
		[["--listen", "ws://localhost:8080"], 'Unsupported --listen transport "ws:"'],
		[["--listen", "unix://relative.sock"], "Unix transport address must not include an authority"],
		[["--listen", "unix:///tmp/pi.sock?wrong=value"], 'Invalid --listen address "unix:///tmp/pi.sock?wrong=value"'],
		[["--listen", "unix:///tmp/pi.sock#fragment"], 'Invalid --listen address "unix:///tmp/pi.sock#fragment"'],
		[["--listen", "unix:/tmp/pi.sock"], 'Invalid --listen address "unix:/tmp/pi.sock"'],
		[["--listen", "unix:///tmp/%00pi.sock"], 'Invalid --listen address "unix:///tmp/%00pi.sock"'],
		[
			["client", "--listen", "unix:///tmp/pi.sock"],
			"The experimental client command does not support existing CLI options yet",
		],
		[
			["server", "--connect", "unix:///tmp/pi.sock"],
			"The experimental server command does not support existing CLI options yet",
		],
		[["client", "--connect", "ws://localhost:8080"], 'Unsupported --connect transport "ws:"'],
		[["client", "--connect", "radius://not-a-server"], "Radius transport address requires"],
		[["server", "--listen", "radius://00000000-0000-4000-8000-000000000001"], "only valid for --connect"],
		[["client", "--provider", "anthropic"], "--provider requires --model"],
		[["client", "-c", "-r"], "--session-id, --continue, and --resume are mutually exclusive"],
		[["server", "--provider", "anthropic"], "--provider requires --model"],
		[["server", "--server-id", "not-a-uuid"], "Invalid --server-id"],
		[["server", "--server-id"], "--server-id requires a value"],
		[["server", "--session-dir"], "--session-dir requires a value"],
		[["client", "-e"], "-e requires a value"],
		[
			["server", "--session-dir", "/tmp/first", "--session-dir=/tmp/second"],
			"--session-dir may only be specified once",
		],
		[["--listen"], "--listen requires a value"],
		[["--connect="], "--connect is only valid for client mode"],
	] as const)("rejects invalid experimental input %j", (argv, error) => {
		const result = cli.parse(argv);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining(error));
	});

	test("rejects unsupported options without parsing them", () => {
		expect(
			cli.parse([
				"client",
				"--listen",
				"ws://localhost:8080",
				"--auth-token",
				"secret",
				"--auth-token-file",
				"/tmp/token",
			]),
		).toEqual({
			ok: false,
			errors: ["The experimental client command does not support existing CLI options yet"],
		});
	});

	test("treats command names after the first argument as existing CLI arguments", () => {
		expect(cli.parse(["--cwd", "/workspace", "server"])).toMatchObject({
			ok: true,
			command: { command: "pi", options: { messages: ["server"] } },
		});
	});
});

# Security Policy

This document describes the security model of `fresh` (a Pi-derived local
coding agent) and where to report vulnerabilities in **this** repository.

In general `fresh` is a coding agent that runs locally within the security
boundary of the user that is running it. It is the responsibility of the user
to monitor its operations or to contain it within a container, virtual machine,
or other sandbox.

`fresh` treats the local user account and files writable by that account as
inside the same trust boundary as the process itself. If an attacker can
modify files under the user's home directory, workspace, shell startup files,
environment, or agent configuration, they can generally influence `fresh` or
other local developer tools. Reports that depend on such prior local write
access are not security vulnerabilities unless they demonstrate how `fresh`
grants that write access or crosses an operating-system privilege boundary.

`fresh` relies on users installing trustworthy extensions and loading trustworthy
skills and only using it within trusted repositories. Files like `AGENTS.md` or
instructions in comments can prompt-inject the coding agent; that cannot be
protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in this repository, report
it privately by either:

- Emailing `hello@felipebasurto.com`, or
- Opening a private report through GitHub Security Advisories for
  [felipebasurto/fresh](https://github.com/felipebasurto/fresh)

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports.

Vulnerabilities in upstream Pi itself should be reported to Earendil, not
here.

## Scope

Security issues in this repository's command-line tools, APIs, and code are
in scope.

## Out Of Scope

- Local code execution or sandboxing behavior (the coding agent intentionally
  does not have a sandbox)
- Behavior of extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by untrustworthy MITM proxies
- Public internet exposure of a `fresh` installation
- Prompt injection attacks
- Exposed secrets that are third-party/user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.pi`,
  `~/.pi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS,
  roaming profiles, or dotfile managers, unless the report shows how `fresh`
  itself grants that access.
- Issues caused by intentionally weakened user configuration.
- Resource/DoS claims that require trusted local input/config against the agent.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.
- Earendil-operated infrastructure on `pi.dev` (report those upstream).

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension/skill are not security
vulnerabilities under this model.

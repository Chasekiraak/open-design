# tools/serve

Follow the root `AGENTS.md` and `tools/AGENTS.md` first. This tool owns small local-development service entrypoints.

## Owns

- `tools-serve` CLI.
- Local static updater fixtures for desktop update IPC and packaged-runtime debugging.
- Identity-bound Codex plugin runtime fixtures that consume a `tools-pack` build report.

## Rules

- Keep services self-contained and local-first.
- Do not put product update runtime logic here; this tool serves deterministic fixtures only.
- New services should use explicit subcommands under `tools-serve start <service>`.
- Codex plugin fixture promotion keeps one `latest` manifest URL, validates the
  complete next build before switching, preserves every previously published
  immutable artifact URL, and rejects fixed-coordinate drift or an attempt to
  replace bytes at an existing version URL.

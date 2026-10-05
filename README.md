# agent-activity-report

Completeness-first, source-linked activity reports from existing AI agent sessions, without extra work for execution agents.

## Status

Early. A command-line report generator for one local calendar day runs on Windows and reads
omp and Claude Code sessions. The Claude Code mapping was checked against client versions
around 2.1.26x–2.1.28x on one Windows machine. Nothing has been verified on macOS, and other
clients (including Codex CLI) are not read.

The agreed requirements and design are in [`docs/changes/1/`](docs/changes/1/); the
[project issues](https://github.com/Eridanus117/agent-activity-report/issues) track open work.

## Usage

Requires [Bun](https://bun.sh) and a logged-in `omp`, which the tool calls non-interactively
(no session saved, no tools) to extract and group events.

```sh
bun install
bun run report --day 2026-10-01 --out <directory outside this repository> [--source omp,claude-code]
```

The report is written to `<out>/<day>/`: `overview.md`, `items.md` and `coverage.json`.
Digests, prompts and model replies stay in a per-user cache directory, never in `<out>`.
`--out`, `--model` and other options can also be set in `~/.config/agent-activity-report/config.json`.

A personal recap page counts what the raw records contain (sessions per day, longest sessions,
messages by hour, most used tools, interruptions) and needs no model. It covers only what the
clients have not yet cleaned up, and the page states the date range each source actually spans.

```sh
bun run recap --out <directory outside this repository> [--from 2026-09-01] [--to 2026-10-05]
```

The page is written to `<out>/recap.html`.

```sh
bun test           # synthetic data only; no model calls
bun run typecheck
```

## Goal

Help people understand what they and their agents worked on, including decisions,
investigations, completed work, failures, cancellations, blockers, and unfinished tasks.
Completeness matters more than delivery frequency.

The intended output has two layers:

- A readable overview of the selected period.
- A complete itemized account, with references back to the source records.

The reporting process reads existing session records independently. Execution
agents must not write extra logs, fill in reporting fields, or invoke a reporting
tool as part of their work.

## Completeness and evidence

Reading every available record and capturing every meaningful activity are different
claims. The project must make source coverage, unsupported inputs, read failures,
and pending work visible rather than silently omitting them.

Plans and attempted actions must not be presented as verified outcomes. Summaries
must remain traceable to the original records; an earlier summary is not a
replacement for those records.

Supported clients and format versions, the implementation language, model
selection, and report format remain open decisions. No client adapter is currently
implemented or validated.

## Development and validation

- Windows is the primary development environment, using synthetic test data.
- macOS is the environment for checking reports against real local session records.
- Both Windows and macOS are intended usage platforms.
- The first acceptance scenario is a report for one complete day, checked against
  its source records for omissions.
- A user interface, notifications, and scheduling are outside the initial work.

Cross-machine continuation uses this repository and its issues, not copied private
transcripts. Platform compatibility and the real-day acceptance scenario have not
yet been verified.

## Privacy boundary

This is a public code repository, not a place to publish activity data.

- Keep real transcripts, generated reports, processing state, model caches,
  credentials, and machine-specific configuration outside the checkout.
- Construct public examples and fixtures from scratch. Do not use real work
  conversations as fixtures, even after attempting to redact them.
- Do not paste private source excerpts, local absolute paths, or internal service
  links into public issues, commits, or pull requests.
- Runtime ignore rules are a precaution, not a guarantee that data is safe to publish.

## License

[MIT](LICENSE).

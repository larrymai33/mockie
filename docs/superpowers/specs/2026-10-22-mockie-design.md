# Mockie design

## Intent

Mockie is a self-hosted coding-practice room for one person. It should feel like an interviewer is quietly present while the candidate thinks and codes, not like a chat bot waiting for alternating turns. The interviewer's default behavior is restraint: listen, observe code and runs, then speak only when a question, a meaningful pause, an important bug, or a time checkpoint makes speaking useful.

## Goals

- Run as a Docker Compose stack on a Proxmox VM or an unprivileged nested-Docker LXC.
- Present a problem, Monaco editor, run output, live transcript, voice controls, and timer in one responsive browser workspace.
- Accept built-in LeetCode-style problems or a custom pasted problem.
- Observe debounced code changes and run results, and use deterministic timing gates plus an LLM judgment to decide whether to speak.
- Use LiteLLM's `chatgpt/` Responses provider with one-time device OAuth and persistent writable credentials.
- Keep the model provider replaceable through settings and include a deterministic offline mock provider.
- Store sessions, events, code, settings, runs, and scorecards in SQLite on a persistent volume.
- Execute Python and JavaScript in a separate, networkless, read-only, resource-limited worker container.
- Survive model and runner failures without losing or terminating the interview.
- Provide a useful end-of-session scorecard and history view.

## Non-goals

- Multi-user accounts, public internet exposure, collaborative editing, or competitive judging.
- A complete LeetCode-compatible test harness or support for every language.
- Perfect browser-independent speech recognition; unsupported browsers keep the complete typed workflow.
- A hardened hostile multi-tenant execution platform. The Proxmox VM is the recommended outer trust boundary.

## Product behavior

An interview begins from a quiet lobby where the candidate selects a built-in problem or pastes one, chooses Python or JavaScript, sets a duration, and confirms the model mode. The room opens immediately with a seeded function signature. Code changes are sent after a short debounce. A server-side policy considers direct questions, completed runs, pauses after meaningful edits, extended silence, and time milestones. The policy first applies deterministic quiet-period and cooldown rules, then asks the provider for `speak` or `silent`; direct candidate questions always receive a response.

The interviewer prompt establishes a stable persona: clarify requirements, probe the candidate's reasoning, ask about edge cases and complexity, and point toward bugs with questions. It must not reveal a full solution, write replacement code, or turn every observation into a message. Spoken replies use browser speech synthesis. Always-on speech recognition pauses during playback to avoid feedback and resumes afterward. Every voice feature has explicit status and mute controls.

Ending an interview freezes the timer and requests a structured five-category scorecard. If the provider is unavailable, a deterministic local scorecard is saved instead. History remains readable after restarts.

## Architecture

- `apps/web`: React, Vite, Monaco, Web Speech APIs, responsive interview-room UI.
- `apps/server`: Fastify API/WebSocket server, SQLite repository, interview engine, LiteLLM Responses adapter, offline adapter, and queue client.
- `apps/runner`: file-queue worker that executes one job at a time with an argv-only subprocess, unprivileged UID, wall/CPU/address-space/file/PID limits, and bounded output.
- `packages/core`: shared contracts, policy state machine, prompts, scorecard validation, and built-in problems.
- `litellm`: private Compose service configured in Responses mode. A separate login profile performs synchronous device login and stores the writable token file in a named volume.
- `caddy`: LAN TLS termination using Caddy's local CA, with persistent CA state.

The app and runner exchange job and result files through a named volume. The runner has `network_mode: none`, a read-only root filesystem, dropped capabilities, `no-new-privileges`, a PID limit, memory/CPU limits, and only tmpfs plus the queue volume. The app never mounts the Docker socket.

## Provider contract

The LiteLLM adapter calls `/v1/responses` with only `model`, `instructions`, and list-form `input`. It never sends `max_tokens`, `max_output_tokens`, `max_completion_tokens`, or `metadata`. Authentication, base URL, model, and mode are configuration. Provider failures become non-fatal status events and do not change the session to ended.

## Visual design

### Tokens

- Paper: `#F3F0E8`, the problem brief and reading surface.
- Ink: `#17201B`, primary type and editor framing.
- Booth green: `#174C3C`, the interview-room anchor color.
- Signal amber: `#E09A32`, only for live listening/thinking state and time pressure.
- Mark red: `#A64232`, errors and destructive actions.
- Console: `#101713`, editor and run-output surface.

Typography uses **IBM Plex Sans** for interface and transcript text and **IBM Plex Mono** for code, time, and machine output, with system fallbacks when self-hosted fonts are unavailable. Copy stays sentence case and left-aligned.

### Layout

Desktop is a three-part working desk with one persistent status rail:

```text
+----------+-------------------------+------------------+
| problem  | editor                  | interviewer      |
| brief    |                         | transcript       |
|          +-------------------------+                  |
|          | run output              | message / mic    |
+----------+-------------------------+------------------+
| room status       timer       end interview           |
+-------------------------------------------------------+
```

Tablet preserves editor priority and turns the brief/transcript into switchable side panels. Mobile stacks a compact problem header, editor, output drawer, and conversation while keeping run, mic, and timer reachable.

### Principles

- The memorable element is the room-status rail: a calm instrument showing `listening`, `reviewing`, `speaking`, or `offline`, never a decorative pulse.
- The transcript resembles concise interview notes, not alternating chat bubbles.
- The editor owns the most space and visual weight.
- Color communicates room state; cards, gradients, and ornamental shadows do not.
- Motion only explains a state change and respects reduced-motion preferences.

### Design self-review

The first pass risked becoming a generic dark developer dashboard. It was revised into a light interview brief wrapped around one dark code surface, borrowing from an actual on-site interview room: paper prompt, shared work surface, discreet observation notes, and a clock. The status rail is specific to the product's core tension—knowing the interviewer is present without constant interruption—and is the single expressive device.

## Operational decisions

- Default duration: 45 minutes.
- Code-change debounce: 750 ms.
- First post-edit consideration: 7 seconds after a meaningful change.
- Extended-silence consideration: 75 seconds, with a 60-second automatic-speech cooldown.
- Languages: Python 3 and JavaScript (Node.js) in the first release.
- SQLite uses WAL mode and lives under `/data`.
- Caddy's local CA is the simplest LAN HTTPS path; each client must trust its root certificate.
- A Proxmox QEMU VM is the documented default. Nested Docker in an unprivileged LXC is supported with `nesting=1,keyctl=1` and an explicit shared-kernel warning.

## Acceptance criteria

- A candidate can start, conduct, run code in, end, and reopen a session entirely in offline mode.
- The timing policy has tests for direct questions, active-progress silence, post-edit pause, extended idle, cooldown, and terminal sessions.
- The runner has tests for correct execution, syntax/runtime failure, output truncation, timeout, language rejection, and effective Compose isolation settings.
- Online requests use the LiteLLM Responses endpoint and omit forbidden fields.
- Model and runner errors appear as recoverable UI status and leave the interview usable.
- A fresh Compose deployment has documented login, persistence, HTTPS trust, Proxmox VM, and LXC procedures.

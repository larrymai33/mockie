# Mockie implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a self-hosted, voice-capable mock coding interview room with LiteLLM ChatGPT OAuth, persistent history, and isolated code execution.

**Architecture:** A TypeScript workspace separates shared deterministic interview logic, a React browser client, a Fastify application server, and a networkless file-queue runner. Docker Compose adds LiteLLM and Caddy while named volumes persist application data, OAuth credentials, TLS state, and the runner queue.

**Tech Stack:** TypeScript, React, Vite, Monaco, Fastify, WebSocket, SQLite, Vitest, Testing Library, Docker Compose, LiteLLM, Caddy.

**Spec:** `docs/superpowers/specs/2026-10-22-mockie-design.md`

## Global constraints

- LiteLLM requests use `/v1/responses` and never include `max_tokens`, `max_output_tokens`, `max_completion_tokens`, or `metadata`.
- Candidate code executes only in the separate networkless runner with bounded time, memory, PIDs, files, output, and CPU.
- Provider and runner errors must not end or corrupt a session.
- Offline mode exercises the complete interview flow without an external model.
- Sessions, settings, scorecards, LiteLLM credentials, and Caddy CA state survive restarts.
- The web app remains usable with speech APIs unavailable and across desktop, tablet, and mobile layouts.

## Review focus

- Duplicate/reordered code updates must not cause repeated interviewer interruptions; cover in core policy tests.
- Provider output may be fenced, malformed, or missing fields; cover in adapter/parser tests with safe fallback.
- Runner jobs may hang or flood output; cover timeout/truncation in runner tests.
- A restart may encounter in-flight queue files or an unavailable runner; cover stale-job/error handling in queue tests.
- Speech recognition may stop or echo speech synthesis; cover the controller state transitions and typed fallback.

---

### Task 1: Workspace and deterministic core

**Files:** root workspace configuration; `packages/core/src/*`; core tests.

**Interfaces:** Produces shared session/event/provider contracts, `decideNextAction`, prompt builders, structured-output parsers, offline provider, and problem catalog.

- [ ] Write policy and parsing tests, run them, and confirm expected missing-module/export failures.
- [ ] Implement the smallest core state machine and parsers that pass the tests.
- [ ] Add offline interview and scorecard behavior, then run the full core suite.

### Task 2: Sandboxed runner

**Files:** `apps/runner/src/*`, runner Dockerfile, queue and sandbox tests.

**Interfaces:** Consumes `RunJob`; produces atomic `RunResult` files keyed by job ID.

- [ ] Write tests for validation, safe argv construction, success, runtime failure, timeout, and truncation; verify red.
- [ ] Implement the single-job worker, limits, atomic results, cleanup, and graceful stale-job recovery.
- [ ] Build the runner image and execute the integration suite inside its locked-down container.

### Task 3: Server, persistence, and provider boundary

**Files:** `apps/server/src/*`; schema/repository, route, engine, WebSocket, queue, and LiteLLM adapter tests.

**Interfaces:** Consumes core contracts and queue protocol; exposes REST `/api/*` and session WebSocket events.

- [ ] Write repository, provider-payload, engine timing/error, and API lifecycle tests; verify red.
- [ ] Implement SQLite persistence, LiteLLM/offline adapters, interview engine, runner client, routes, and socket hub.
- [ ] Run server tests and verify a session survives injected provider/runner errors.

### Task 4: Interview-room web client

**Files:** `apps/web/src/*`; component/controller tests and responsive styles.

**Interfaces:** Consumes the server REST/WebSocket API; provides lobby, room, history, settings, speech recognition, and speech synthesis.

- [ ] Write UI/controller tests for start flow, typing fallback, mic lifecycle, code debounce, run output, recoverable errors, ending, and history; verify red.
- [ ] Implement the token system, responsive shell, Monaco editor, transcript, timer, voice controller, scorecard, and history.
- [ ] Run unit tests and production build, then inspect desktop and mobile screenshots and revise visual/accessibility defects.

### Task 5: Compose, OAuth, HTTPS, and documentation

**Files:** Dockerfiles, `compose.yaml`, LiteLLM/Caddy config, environment example, scripts, README.

**Interfaces:** Produces `docker compose` workflows for auth login, offline start, online start, verification, backup, and deployment.

- [ ] Write a test that parses effective Compose configuration and asserts runner isolation, private service exposure, volumes, health checks, and persistence; verify red.
- [ ] Implement multi-stage images, LiteLLM auth initialization/login profile, Responses-mode config, Caddy local TLS, volumes, and health checks.
- [ ] Document quick start, device login, token refresh persistence, model switching, Proxmox VM/LXC, LAN DNS/cert trust, security boundary, backups, and troubleshooting.
- [ ] Validate Compose configuration and run the offline stack smoke test.

### Task 6: End-to-end verification and commit

**Files:** end-to-end smoke tests and any fixes discovered by verification.

**Interfaces:** Verifies the complete user path and leaves a clean committed repository.

- [ ] Run all tests, typechecks, builds, runner integration tests, and Compose validation from a clean install.
- [ ] Conduct the offline browser flow: start session, edit, pause, receive a restrained response, run code, end, view scorecard, reopen history.
- [ ] Review the requirement checklist and security-sensitive diff, fix all critical/important findings, and repeat affected verification.
- [ ] Commit the verified repository with a descriptive initial commit.

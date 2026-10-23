# Runner

The worker claims one `/queue/jobs/<jobId>.json` at a time by renaming it into
`processing/`, then publishes `results/<jobId>.json` using an atomic hard link
from a fully written, fsynced temporary file. Writers must publish job files by
atomic rename too. Job IDs and session IDs allow letters, numbers, `_`, and `-`.
Run one worker replica for each queue volume. Restarted processing jobs become
recoverable errors; code with possible side effects is never replayed.

The queue protocol matches `RunJob`/`RunResult` from `@mockie/core`. Jobs allow
`python` or `javascript`, bounded code and optional stdin (65,536 characters
each), ISO `createdAt`, and optional positive `timeoutMs`. A job can shorten,
but cannot extend, the supervisor's wall timeout. Results contain `jobId`,
`sessionId`, `status`, `stdout`, `stderr`, `exitCode`, `durationMs`, `truncated`,
and `completedAt`. Invalid jobs receive `rejected` results. Filename/ID
mismatches are rejected and cannot redirect output outside the queue.

The production service runs a root supervisor with group 10001 and only
`SETUID`, `SETGID`, and `KILL` capabilities. It starts each candidate with UID/GID
65534, clears the environment, and uses argv-only `setpriv` and `prlimit`
commands. `setpriv` clears supplementary groups and inheritable/ambient
capabilities; changing identity clears effective/permitted child capabilities.
`no-new-privileges` prevents a child executable from gaining them
back. `KILL` lets the supervisor terminate the different-UID child's process
group. The queue is owned by 0:10001 with mode 0770, its subdirectories use 0770,
and result/heartbeat files use 0640. The API runs as 10001:10001 and can publish
jobs and read results. Candidate work files are placed under `/tmp` and removed
after use; candidate groups cannot access the queue.

Limits are 5 seconds wall time (configurable up to 10 seconds), 3 seconds CPU,
2 GiB virtual address space, 1 MiB per output file, 32 processes per child UID,
64 open files, no core dumps, and 64 KiB each for captured stdout/stderr. Node's
heap is additionally capped at 64 MiB and uses `--jitless` to fit the virtual
address-space limit. These complement container memory/PID/CPU limits. One
child UID is shared because jobs execute serially. The worker terminates the
process group after both timeout and normal parent exit.

`RUNNER_QUEUE_DIR` defaults to `/queue`; `RUNNER_CHILD_UID` and
`RUNNER_CHILD_GID` default to 65534 and reject zero. `RUNNER_TIMEOUT_MS` defaults
to 5000. `RUNNER_OUTPUT_LIMIT_BYTES` defaults to 65536 and cannot exceed it.
`node dist/index.js healthcheck` checks the atomic heartbeat and live supervisor.
SIGTERM stops polling and drains the current bounded job before clearing health.

From the repository root:

```powershell
npm run test -w @mockie/runner
npm run build -w @mockie/runner
docker build -f apps/runner/Dockerfile -t mockie-runner .
docker run --rm --init --network none --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 --tmpfs /tmp:rw,nosuid,nodev,size=64m mockie-runner node scripts/linux-integration.mjs
```

The Linux integration suite uses the actual Python/Node interpreters, `prlimit`,
child identity/capability transitions, process groups, and protected queue. Unit
tests inject command construction and avoid Linux UID/rlimit assumptions so
they can also run on Windows. The service itself requires the Linux image.

This is a single-user execution worker, not a hostile multi-tenant sandbox.
Use a VM as the outer trust boundary and enforce Compose's networkless,
read-only, limited-resource configuration. Filesystem and process namespaces
inside the container remain shared between the supervisor and candidate code.

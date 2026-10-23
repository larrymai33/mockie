import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommand, executeJob, QueueWorker } from '../dist/runner.js';

assert.equal(process.platform, 'linux', 'Run this suite inside the runner Linux image');
assert.equal(process.getuid(), 0, 'Integration exercises the privileged supervisor dropping child identity');
const root = await mkdtemp(join(tmpdir(), 'mockie-integration-'));
// Optional host-only Node path; the Docker invocation exercises the fixed image path.
const hostNode = process.env.MOCKIE_INTEGRATION_NODE;
const options = {
  childUid: 65534, childGid: 65534,
  ...(hostNode ? { commandBuilder: (language, file) => {
    const command = buildCommand(language, file);
    return { ...command, args: command.args.map((arg) => arg === '/usr/local/bin/node' ? hostNode : arg) };
  } } : {}),
};
const job = (language, code, extras = {}) => ({
  id: 'integration', sessionId: 'integration-session', language, code,
  createdAt: new Date().toISOString(), ...extras,
});
try {
  const python = await executeJob(job('python', 'import sys\nprint("hello " + sys.stdin.read())', { stdin: 'python' }), options);
  assert.equal(python.status, 'success', JSON.stringify(python));
  assert.equal(python.stdout, 'hello python\n');

  const js = await executeJob(job('javascript', 'process.stdout.write("hello js")'), options);
  assert.equal(js.status, 'success', JSON.stringify(js));
  assert.equal(js.stdout, 'hello js');

  const identity = await executeJob(job('python', 'import os,json\nprint(json.dumps({"uid":os.getuid(),"gid":os.getgid()}))'), options);
  assert.equal(identity.status, 'success', JSON.stringify(identity));
  assert.deepEqual(JSON.parse(identity.stdout), { uid: 65534, gid: 65534 });

  const caps = await executeJob(job('python', 'print(open("/proc/self/status").read())'), options);
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    assert.match(caps.stdout, new RegExp(`${name}:\\s+0{16}`), `Child retained ${name}`);
  }
  assert.match(caps.stdout, /NoNewPrivs:\s+1/, 'Use --security-opt no-new-privileges when running the image');
  assert.match(caps.stdout, /Groups:\s*\n/, 'Child retained supplementary groups');

  // Queue ownership prevents candidate code from replacing its own result or reading other jobs.
  const worker = new QueueWorker(root, options);
  await worker.initialize();
  const denied = await executeJob(job('python', `import os\nos.listdir(${JSON.stringify(root)})`), options);
  assert.equal(denied.status, 'error');
  assert.match(denied.stderr, /PermissionError/);

  const limits = await executeJob(job('python', 'import resource,json\nprint(json.dumps([resource.getrlimit(x) for x in [resource.RLIMIT_CPU,resource.RLIMIT_AS,resource.RLIMIT_FSIZE,resource.RLIMIT_NPROC,resource.RLIMIT_NOFILE,resource.RLIMIT_CORE]]))'), options);
  assert.equal(limits.status, 'success', JSON.stringify(limits));
  assert.deepEqual(JSON.parse(limits.stdout), [[3, 3], [2147483648, 2147483648], [1048576, 1048576], [32, 32], [64, 64], [0, 0]]);

  const failure = await executeJob(job('python', 'raise RuntimeError("integration failure")'), options);
  assert.equal(failure.status, 'error');
  assert.match(failure.stderr, /integration failure/);
  const syntax = await executeJob(job('javascript', 'function ( {'), options);
  assert.equal(syntax.status, 'error');
  assert.match(syntax.stderr, /SyntaxError/);

  const timeout = await executeJob(job('python', 'while True: pass'), { ...options, timeoutMs: 100 });
  assert.equal(timeout.status, 'timeout');
  const truncated = await executeJob(job('python', 'print("x" * 100000)'), { ...options, outputLimitBytes: 1000 });
  assert.equal(truncated.stdout.length, 1000);
  assert.equal(truncated.truncated, true);
  assert.equal((await executeJob(job('sh', 'echo unsafe'), options)).status, 'rejected');

  // Parent exit must not leave a detached job descendant using resources or holding pipes open.
  const descendant = await executeJob(job('python', 'import os,time\npid=os.fork()\nif pid == 0:\n time.sleep(30)\nelse:\n print(pid,flush=True)'), options);
  assert.equal(descendant.status, 'success', JSON.stringify(descendant));
  assert.ok(descendant.durationMs < 5000, 'Descendant was not terminated with its parent');

  // A candidate must not escape the wall timer by starting a new process session.
  const escaped = await executeJob(job('python', 'import os,time\npid=os.fork()\nif pid == 0:\n os.setsid()\n time.sleep(3)\nelse:\n print(pid,flush=True)'), options);
  assert.equal(escaped.status, 'success', JSON.stringify(escaped));
  assert.ok(escaped.durationMs < 1500, 'Detached descendant escaped job cleanup');
  const escapedPid = Number(escaped.stdout.trim());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(escapedPid, 0), error => error?.code === 'ESRCH', 'Detached descendant is still alive');

  await writeFile(join(root, 'jobs', 'integration.json'), JSON.stringify(job('javascript', 'console.log("queue")')));
  await worker.runOnce();
  const result = JSON.parse(await readFile(join(root, 'results', 'integration.json'), 'utf8'));
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(result.stdout, 'queue\n');
  assert.deepEqual(await readdir(join(root, 'processing')), []);
  assert.equal(buildCommand('python', '/tmp/code').executable, '/usr/bin/setpriv');
  console.log('Linux runner integration passed: interpreters, uid/gid, capabilities, rlimits, queue protection, errors, timeout, output bounds, descendants, queue protocol.');
} finally {
  await rm(root, { recursive: true, force: true });
}

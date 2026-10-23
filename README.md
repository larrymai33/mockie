# Mockie

Mockie is a self-hosted coding interview room for one person. Pick a built-in problem or paste your own, write Python or JavaScript, run it, and think aloud or type to an interviewer that follows your code without interrupting every edit. A timer, problem brief, editor, run output, transcript, and voice controls share one workspace. End the interview for a five-category scorecard, then reopen it from History.

Offline mode uses a deterministic local practice partner. Online mode sends interview context through a private LiteLLM proxy using its `chatgpt/` subscription provider. Model failures leave the session usable; scoring falls back locally when necessary. Offline mode does not require model credentials, although initial image builds need internet access and browser speech recognition may use a remote service.

This is a trusted, single-user LAN application. There are no user accounts or application access controls. Anyone who can reach it can read sessions, change settings, and submit code. Use a dedicated VM as the outer boundary for running candidate code; do not publish the service directly to the internet.

## Architecture

```text
Browser: React + Monaco + Web Speech
                 │ HTTPS / WebSocket
                 ▼
              Caddy                 local CA, TCP 443 only
                 │
                 ▼
          Fastify application ──────► LiteLLM ──────► ChatGPT
                 │                    online profile, OAuth volume
                 ├── SQLite           sessions, events, settings, runs, scorecards
                 │
                 └── named file queue ──────► Runner
                                              Python / Node.js
                                              no network, bounded subprocesses
```

The interview policy first applies deterministic timing gates, then lets the provider decide whether speaking is useful. Code saves are debounced by 750 ms; post-edit consideration begins after 7 seconds, extended silence after 75 seconds, and automatic speech has a 60-second cooldown. Direct questions, completed runs, and time checkpoints also inform the policy. The offline provider exercises the same session workflow.

The application container runs as UID/GID `10001:10001`. The runner supervisor runs as `0:10001` with only the capabilities required to drop child identity and terminate child process groups; candidate programs run as `65534:65534`. Only the app and runner share the queue volume. Neither mounts the Docker socket.

## Quick start: offline

Requirements: a Linux Docker Engine with the Compose v2 plugin, or Docker Desktop in **Linux containers** mode; Git; a modern browser; and a hostname that resolves to your Docker host. Node is not needed for this deployment. For a server, use the Proxmox VM procedure below. See the official [Docker Engine installation instructions](https://docs.docker.com/engine/install/) and [Compose installation options](https://docs.docker.com/compose/install/).

Run from the repository root. Obtain this repository from your Git remote or copy it to the host first.

```sh
cp .env.example .env
```

On PowerShell, the equivalent is `Copy-Item .env.example .env`. Edit `.env`:

```dotenv
MOCKIE_HOST=mockie.home.arpa
MOCKIE_PORT=443
MOCKIE_BIND_IP=192.168.1.50
MOCKIE_MODE=offline
LITELLM_MASTER_KEY=sk-replace-with-a-long-random-secret
```

Replace `MOCKIE_BIND_IP` with this VM or container's trusted LAN address; Caddy binds only that interface. Choose a fresh random proxy secret even if you initially use offline mode. For example, `openssl rand -hex 32` generates random material on hosts with OpenSSL. Keep `.env` private and out of Git.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 app runner caddy
```

The one-shot queue initializer should exit successfully; the app, runner, and Caddy should stay running. The online and login services are excluded by default. Only Caddy publishes a host port. The app's port 3000 and LiteLLM's port 4000 are private to Compose.

Point `mockie.home.arpa` at the host's LAN IP and install Caddy's root certificate using the next section. Then open **`https://mockie.home.arpa`**. If port 443 is occupied, set `MOCKIE_PORT=8443`, recreate Caddy with `docker compose up -d caddy`, and open `https://mockie.home.arpa:8443`. The hostname has no scheme or port in `.env`. No host port 80 is published, so enter `https://` explicitly.

Select **Offline practice**, start an interview, add a small test call to the starter function, and use **Run code**. A function definition alone can finish successfully without output. End the interview and check History to exercise persistence. These are deployment smoke checks to perform on your host, not a claim that every environment has been tested.

## LAN HTTPS and microphone access

### Resolve the hostname

Create a local DNS A record on your router, Pi-hole, AdGuard Home, or another LAN resolver:

```text
192.168.1.50  mockie.home.arpa
```

Replace the example IP with the VM/Docker host's address. Reserve that address in DHCP. Alternatively, add the same line to each desktop client's hosts file: `C:\Windows\System32\drivers\etc\hosts` on Windows, or `/etc/hosts` on macOS/Linux. Editing requires administrator privileges. Phones normally need working LAN DNS rather than a hosts-file edit. Check that browser secure DNS, a VPN, or Android Private DNS does not bypass your LAN resolver. Add an AAAA record only if IPv6 reaches this same host correctly.

Use the configured hostname in the browser, not an arbitrary IP address: the TLS certificate must match the name. For a browser on the Docker host alone, mapping the name to `127.0.0.1` is possible; remote clients need the host's reachable LAN address.

### Extract the public root certificate

`infra/caddy/Caddyfile` uses `tls internal`. Caddy creates a local CA and renews its site certificates, but a container cannot install that CA into remote clients' trust stores. Each client needs its public root. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https) and its [Docker Compose trust procedure](https://caddyserver.com/docs/running#docker-compose).

After Caddy has started:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./mockie-root.crt
```

Transfer **only `mockie-root.crt`** to your clients through a channel you trust, such as SCP or direct file transfer. Do not distribute the CA private key or the `caddy_data` volume. Optionally compare the certificate's SHA-256 fingerprint on server and client before trusting it:

```sh
openssl x509 -in mockie-root.crt -noout -subject -fingerprint -sha256
```

Trusting this CA allows certificates it signs to authenticate sites on that client; install only the root obtained from your own deployment. Preserve `mockie_caddy_data` so rebuilding the container does not generate a new CA and require another trust installation.

### Trust the root on clients

**Windows:** in a normal PowerShell window, install for your current user:

```powershell
certutil -user -addstore Root .\mockie-root.crt
```

Alternatively, double-click the file, choose **Install Certificate → Current User → Place all certificates in the following store → Trusted Root Certification Authorities**. Approve only your own CA. Restart the browser. Microsoft documents the options in the [certutil reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil).

**macOS:** import the file into the **System** keychain using Keychain Access, open the imported certificate, expand **Trust**, and set SSL trust to **Always Trust**, authenticating when requested. Restart the browser. See Apple's [certificate trust instructions](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac).

**iOS/iPadOS:** transfer the root to the device and open it, install the downloaded certificate profile under **Settings → General → VPN & Device Management**, then enable its root under **Settings → General → About → Certificate Trust Settings → Enable Full Trust for Root Certificates**. Profile installation alone is insufficient; see [Apple's root trust instructions](https://support.apple.com/en-us/102390). Managed devices may need administrator assistance.

**Android:** transfer the file, open **Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**, and select it. Menu names vary by Android version and manufacturer; use the **CA certificate** choice rather than Wi-Fi or client credentials. A device lock may be required. Check the browser afterwards: individual apps may ignore user-installed CAs. Google's [certificate management guide](https://support.google.com/pixelphone/answer/2844832) describes the general settings area.

**Linux:** on Debian/Ubuntu clients:

```sh
sudo install -m 0644 mockie-root.crt /usr/local/share/ca-certificates/mockie-root.crt
sudo update-ca-certificates
```

On Fedora/RHEL-family clients:

```sh
sudo install -m 0644 mockie-root.crt /etc/pki/ca-trust/source/anchors/mockie-root.crt
sudo update-ca-trust
```

Restart the browser. Firefox or another browser with a separate certificate store may additionally need **Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import** and trust for identifying websites. Some enterprise policies control this separately. Caddy notes the [system/browser trust-store distinction](https://caddyserver.com/docs/running#local-https-with-systemd).

Finally, visit the HTTPS address without a certificate warning. In the browser console, `window.isSecureContext` should be `true`. From a client with the copied root, a direct check is:

```sh
curl --cacert ./mockie-root.crt https://mockie.home.arpa/api/health
```

Expect an object containing `"ok":true`. Adjust the URL for a custom port. Clicking through a certificate warning is not a dependable substitute for installing trust.

### Voice caveats

Microphone access needs browser permission and an appropriate secure context. Plain HTTP on a LAN IP is unsuitable; `localhost` development has special treatment. See MDN's [secure-context rules](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) and [microphone permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security).

Mockie uses browser `SpeechRecognition`/`webkitSpeechRecognition` and `speechSynthesis`, with recognition currently set to `en-US`. Recognition pauses during interviewer playback and resumes when listening remains enabled. Use the separate microphone and spoken-output controls, allow browser and OS microphone permissions, and keep the page in the foreground on mobile devices. Headphones reduce feedback.

Speech recognition support varies by browser, OS, policy, and network. Some implementations send audio to a browser vendor's service and cannot work offline; Mockie does not force on-device recognition. Check MDN's current [SpeechRecognition compatibility and service caveats](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition). A trusted HTTPS page does not guarantee speech support. Typed messages, code editing, execution, and history remain available when voice is unavailable.

## Quick start: online with headless ChatGPT OAuth

Complete the offline deployment and HTTPS setup first. You need a ChatGPT account with access to a supported model, device-code sign-in allowed by its security/workspace settings, and outbound internet access from the login and LiteLLM services. This path uses LiteLLM's subscription OAuth provider; the local proxy master key is a separate secret.

1. In `.env`, set `MOCKIE_MODE=online` and `COMPOSE_PROFILES=online`, set a strong `LITELLM_MASTER_KEY`, and choose an available `MOCKIE_MODEL`. Keep `LITELLM_BASE_URL=http://litellm:4000` for the bundled proxy; do not append `/v1`. `MOCKIE_MODE` selects the provider in Mockie; `COMPOSE_PROFILES` starts the bundled proxy.
2. Build the login image and run its interactive, synchronous authenticator:

   ```sh
   docker compose --profile login build litellm-login
   docker compose --profile login run --rm litellm-login
   ```

3. The terminal prints a device verification URL and a one-time code. Open the **printed URL** in a browser on your laptop or phone, sign in to the intended account/workspace, and enter the printed code. Keep the terminal command running until it confirms that credentials were saved. The server needs no desktop browser or callback port. Keep the code private.
4. Start the online stack only after login completes:

   ```sh
   docker compose --profile online up -d --build
   docker compose --profile online ps -a
   docker compose --profile online logs --tail=100 litellm app
   ```

5. Open **Settings** and choose the connected interviewer/model, then start a new interview with **Connected interviewer** selected. Ask a short typed question to check real upstream access. Container liveness alone does not verify OAuth or model access.

LiteLLM documents why proxy workers cannot perform interactive first login and why this must happen [before starting the proxy](https://docs.litellm.ai/docs/providers/chatgpt#sign-in-before-starting-the-proxy). If a proxy was started without credentials, restart it after login:

```sh
docker compose --profile online restart litellm
```

Both login and proxy mount the same writable `litellm_auth` volume and use `CHATGPT_TOKEN_DIR=/auth/chatgpt`. The token file is `/auth/chatgpt/auth.json`; the initialization service gives UID/GID `65534:65534` ownership. `--rm` removes the login container, not this named volume. Credentials are reused and refreshed; do not replace the volume with a read-only mount. The [pinned LiteLLM authenticator source](https://github.com/BerriAI/litellm/blob/v1.106.0/litellm/llms/chatgpt/authenticator.py) shows token loading and refresh writes.

If login is revoked or refresh fails, stop the proxy, rerun login, and start it again. The authenticator may reuse an existing valid token, so a forced account change requires moving the old file aside first. This preserves the old file for recovery but it remains a credential; protect it and remove it securely when no longer needed:

```sh
docker compose --profile online stop litellm
docker compose --profile login run --rm --entrypoint python litellm-login -c "from pathlib import Path; p=Path('/auth/chatgpt/auth.json'); p.rename(p.with_name('auth.json.previous')) if p.exists() else None"
docker compose --profile login run --rm litellm-login
docker compose --profile online up -d litellm
```

Do not run multiple independent proxies with copied refresh-token files. A stale backup may require a new login after restore because refresh rotates credentials. Keep the normal deployment at one LiteLLM instance.

### Model availability and switching

The repository default is **`chatgpt/gpt-5.4`**, not a promise of current availability. It may be retired, unavailable to your account, or replaced upstream. Settings suggestions are examples rather than an entitlement or live discovery list. Consult the current [LiteLLM ChatGPT provider documentation](https://docs.litellm.ai/docs/providers/chatgpt) and your account's model access, then enter an available exact `chatgpt/<model-id>` value.

The bundled `infra/litellm/config.yaml` routes `chatgpt/*` using Responses mode, so changing between supported ChatGPT model IDs normally only requires changing Mockie's model. Use **Settings → Model → Save settings** for an existing installation. `.env` supplies server defaults; saved SQLite settings take precedence over those defaults. A session captures offline/online mode when created, while online provider configuration is read from current settings. Start a new interview after changing mode for a clear transition.

For another LiteLLM provider, add its model route and credentials to the proxy configuration, use a Responses-compatible model, and update Mockie's base URL/model/key settings. The UI exposes the default mode and model; connection credentials/base URL are server defaults or the settings API. Do not expose port 4000 just to configure them.

Mockie calls **`POST /v1/responses`** with only `model`, `instructions`, and message-list `input` in the JSON body. It does not send `max_tokens`, `max_output_tokens`, `max_completion_tokens`, or `metadata`. Do not add those fields for the ChatGPT subscription provider; see its [request compatibility notes](https://docs.litellm.ai/docs/providers/chatgpt). `drop_params: true` in the proxy is additional protection, not a reason to add unsupported request fields.

## Configuration

Compose reads `.env` for interpolation; directly launched Node processes do not automatically load that file. Paths below are **container paths** in a Compose deployment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOCKIE_HOST` | `mockie.home.arpa` | Hostname served by Caddy; configure matching LAN DNS. |
| `MOCKIE_PORT` | `443` | Published host HTTPS port. |
| `MOCKIE_BIND_IP` | example LAN address | Required host interface for HTTPS; replace with the VM/LXC's trusted LAN address. |
| `MOCKIE_MODE` | `offline` | Default provider mode, before saved settings override it. |
| `COMPOSE_PROFILES` | empty | Set to `online` to include the bundled LiteLLM service without repeating `--profile online`. |
| `MOCKIE_MODEL` | `chatgpt/gpt-5.4` | Configurable model default; availability must be checked. |
| `MOCKIE_SESSION_MINUTES` | `45` | Server duration default; API accepts 10–180 minutes. |
| `LITELLM_BASE_URL` | `http://litellm:4000` | Proxy origin, without `/v1`. |
| `LITELLM_MASTER_KEY` | example placeholder | Proxy bearer secret shared with app; replace it. |
| `DATABASE_PATH` | `/data/mockie.db` | SQLite path; keep under the persisted `/data` mount. |
| `RUNNER_QUEUE_PATH` | `/queue` | Shared queue path; keep `/queue` unless also changing mounts. |
| `RUNNER_TIMEOUT_MS` | `4000` | Runner wall timeout, positive integer, maximum 10000. |
| `RUNNER_MAX_OUTPUT_BYTES` | `65536` | Capture limit for each stdout/stderr stream, maximum 65536. |
| `LITELLM_VERSION` | `1.106.0` | Optional image build argument; rebuild login and proxy together. |

Compose maps `RUNNER_QUEUE_PATH` to the worker's `RUNNER_QUEUE_DIR`, and `RUNNER_MAX_OUTPUT_BYTES` to its `RUNNER_OUTPUT_LIMIT_BYTES`. The standalone worker otherwise defaults to 5000 ms. Changing an environment path alone does not move a volume mount. Container `HOST`/`PORT` are fixed by Compose at `0.0.0.0:3000`; `WEB_DIST_PATH` is set by the app image.

After editing `.env`, use `docker compose up -d` (add `--profile online` before `up` when needed) to recreate affected services. `docker compose restart` alone does not apply changed environment variables. If persisted settings include an old model/key/base URL, update those settings too. The settings API accepts `providerMode`, `model`, `baseUrl`, `apiKey`, `defaultDurationMinutes`, `autoSpeak`, and `autoListen`; provider keys can be replaced but are never returned by the API. Treat access to it as access to the whole installation.

## Using the room

Choose a built-in problem or paste a custom problem, select Python 3 or JavaScript, choose a duration, and select an interviewer mode. The room starts with a function signature; add your own calls/assertions and output. This is a practice runner, not a complete LeetCode judge or hidden-test harness. There is no package installation or network access inside candidate execution.

Edit code and wait for the saved indicator before leaving. **Run code** executes the current script, shows stdout/stderr, and gives the interviewer a run result. Ask about requirements, edge cases, or complexity using a typed message or microphone. Use **Use plain editor** if Monaco is inconvenient on your device. Mic and spoken-output controls are independent.

End the interview explicitly to save its scorecard. History contains finished and active sessions; reopen an active session to continue or a completed session to review its code, runs, transcript, and scorecard. Elapsed time is based on the stored start time and continues across refreshes/restarts; leaving the browser is not a pause. Provider or runner errors are shown as recoverable status messages. A failed model call does not end the interview, and a local scorecard can be saved if online scoring fails.

## Proxmox deployment: QEMU VM recommended

A Linux VM gives the runner a separate guest kernel and keeps Docker away from the Proxmox host. Proxmox recommends a QEMU VM for application containers in its [container documentation](https://pve.proxmox.com/pve-docs/chapter-pct.html); its [VM guide](https://pve.proxmox.com/pve-docs/chapter-qm.html) covers the underlying choices. The following resource allocation is a starting recommendation for one user, not a measured minimum.

1. Download an Ubuntu Server 24.04 LTS amd64 ISO and upload it to your Proxmox ISO storage. Create a dedicated VM in the web UI; use a local VM ID/name of your choice. Do not install Docker on the hypervisor.
2. Select the ISO and Linux guest type. Use the defaults appropriate to your Proxmox installation, a VirtIO SCSI controller/disk, a 32 GB or larger disk, 2 vCPUs, and 4 GB RAM (more helps image builds). Attach a VirtIO network adapter to the LAN bridge, usually `vmbr0`. Ensure the VM is on the intended trusted LAN/VLAN.
3. Install Ubuntu, a normal administrator account, and OpenSSH if desired. Remove the ISO after installation. Reserve a stable IP in DHCP or configure a static address. Enable the VM's QEMU Guest Agent option, then inside Ubuntu run:

   ```sh
   sudo apt update
   sudo apt upgrade -y
   sudo apt install -y qemu-guest-agent ca-certificates curl git
   sudo systemctl start qemu-guest-agent
   ```

4. Install Docker Engine **inside the VM** using Docker's [Ubuntu apt repository instructions](https://docs.docker.com/engine/install/ubuntu/). Include the Compose plugin. The final package step, after setting up that repository, is:

   ```sh
   sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo systemctl enable --now docker
   sudo docker run --rm hello-world
   sudo docker compose version
   ```

5. Use `sudo docker ...` for the commands in this README, or deliberately grant your administrator Docker access. Docker group membership grants extensive host control; see [Docker's post-install guidance](https://docs.docker.com/engine/install/linux-postinstall/). Copy/clone this repository into the VM and perform the offline quick start before OAuth setup.
6. Point LAN DNS at the **VM address**. Permit inbound TCP 443 (or your configured HTTPS port) from trusted clients and SSH only where needed. Leave 3000/4000 unpublished. Check Proxmox, guest, and Docker firewall behavior; [Docker-published ports can bypass some host firewall rules](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
7. Install the Caddy root on each browser device, complete the online login if desired, and perform the smoke checks. Enable the VM's **Start at boot** option. Compose's long-running services use `restart: unless-stopped`.
8. Schedule Proxmox backups and retain an application/volume backup as described below. For a consistent snapshot, stop writers or use an application-aware backup procedure. Keep the VM dedicated to Mockie and avoid attaching unrelated host data or secrets.

Docker inside a Linux QEMU guest does not require nested KVM virtualization; it uses the guest's Linux container features.

### Alternative: unprivileged LXC with nested Docker

Use this only if you accept its shared-kernel boundary and can troubleshoot host-specific nesting/storage behavior. An unprivileged LXC still shares the Proxmox kernel; Docker and the candidate runner add namespaces rather than a separate kernel. A QEMU VM remains the recommended deployment for executing untrusted practice code.

Create a fresh **unprivileged** Ubuntu/Debian container with LAN networking, persistent root disk, and sufficient CPU/RAM/disk (the VM allocation above is a reasonable starting point). Enable **Nesting** and **keyctl** under its feature settings. Equivalently, on the **Proxmox host**, replace `123` with the exact container ID:

```sh
pct config 123
pct stop 123
pct set 123 --features nesting=1,keyctl=1
pct start 123
pct config 123
```

Inspect existing features first: setting `--features` can replace that feature list, so preserve other deliberately configured entries. Confirm `unprivileged: 1` and the intended features. See Proxmox's [`pct` feature reference](https://pve.proxmox.com/pve-docs/pct.1.html), including the security implications of nesting and the `keyctl` requirement for Docker in unprivileged containers.

Enter the container with `pct enter 123`, install Docker/Compose from the distribution-appropriate official Docker repository, and follow the same quick start. Use the **LXC's IP** in LAN DNS. Keep Docker data in the container's backed-up storage, and verify that your storage driver, cgroups, AppArmor, and Docker version work together. Permission/overlay/cgroup errors are reasons to use the VM path, not to change the container to privileged, disable AppArmor broadly, mount the host Docker socket, or add host directory passthrough. LXC mount points may have separate backup inclusion rules; check your Proxmox backup configuration.

## Execution security and limits

The Compose runner has **no network**, no published ports, **no Docker socket**, and **no host-directory bind mount**. Its root filesystem is read-only; `/tmp` is a 128 MiB `noexec,nosuid,nodev` tmpfs, and the only writable persistent mount is the named queue. The app and proxy have network access; the runner does not.

Container limits are 256 MiB memory with the same memory+swap ceiling, 0.5 CPU, and 64 PIDs. All capabilities are dropped, then only `SETUID`, `SETGID`, and `KILL` are added for the root supervisor. `no-new-privileges` is enabled. Candidate commands use argv rather than shell interpolation, a cleared environment, UID/GID 65534, no supplementary groups, and cleared inherited/ambient capabilities. Queue directories are owned by `0:10001` with mode `0770`, excluding that candidate identity.

Each job has a configurable 4-second wall limit in Compose (maximum 10 seconds), plus 3 CPU seconds, 2 GiB virtual address space, a 1 MiB per-file size limit, 32 processes per child UID, 64 open files, no core dumps, and at most 64 KiB captured per output stream. Node also has a 64 MiB heap cap and runs with `--jitless`. Job source/stdin each have a 65,536-character worker limit. One worker handles one job at a time; do not scale multiple replicas onto the same queue. Process groups are terminated after timeout and after normal parent exit. See the [runner implementation notes](apps/runner/README.md).

These controls bound ordinary resource abuse; they are not a hardened hostile multi-tenant sandbox. Candidate code and the supervisor still share container process/filesystem namespaces and a kernel. Keep the outer VM dedicated, patch it, and avoid giving it unrelated data or broad LAN access. Docker describes its [runtime resource controls](https://docs.docker.com/engine/containers/resource_constraints/) and [security boundary](https://docs.docker.com/engine/security/). Do not remove isolation flags to make a failing job work.

## Persistence, backups, and restores

| Named Docker volume | Contents | Backup priority |
| --- | --- | --- |
| `mockie_data` | `/data/mockie.db`, SQLite WAL/SHM, all sessions/settings | Essential |
| `litellm_auth` | ChatGPT OAuth tokens under `chatgpt/` | Sensitive; re-login may still be needed |
| `mockie_caddy_data` | Caddy CA private keys/certificates | Essential to preserve client trust |
| `mockie_caddy_config` | Caddy configuration state | Include with deployment backup |
| `mockie_runner_queue` | Queue/processing/results/heartbeat | Operational state; not history's source of truth |

The volume names are explicit and shared across Compose project names. Running a second checkout on the same Docker host will reuse them unless you edit the volume names. Normal container rebuild/recreation preserves history. **`docker compose down -v` deletes named volumes and is not an update command.**

For a simple consistent backup, finish current work, wait for code to save, and stop all writers. The following is **Bash on the Linux Docker host**, using a new timestamped backup directory and a temporary helper container. Do not run these Bash loops unchanged in PowerShell. Pull the helper before stopping to reduce downtime.

```sh
docker pull busybox:1.37
backup_dir="$PWD/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
docker compose --profile online stop
for volume in mockie_data litellm_auth mockie_caddy_data mockie_caddy_config mockie_runner_queue; do
  docker volume inspect "$volume" >/dev/null || continue
  docker run --rm --network none --mount "type=volume,src=$volume,dst=/source,readonly" --mount "type=bind,src=$backup_dir,dst=/backup" busybox:1.37 tar -czf "/backup/$volume.tgz" -C /source .
done
cp .env compose.yaml "$backup_dir/"
cp -R infra "$backup_dir/infra"
chmod -R go-rwx "$backup_dir"
docker compose --profile online up -d
```

For an offline-only installation, use `docker compose stop` and `docker compose up -d` in that procedure, excluding the `online` profile so it does not start a proxy you have not authenticated. Keep a copy of the exact source revision/image versions with the backup. Check every archive command succeeds before treating the backup as complete; move an encrypted copy off the Docker host. The backup contains proxy secrets and the CA signing key. The helper's host bind mount is only for this operator-controlled backup, not part of the candidate runner.

SQLite uses WAL: never copy only the live `mockie.db` while the app is writing. Stopping the app and archiving the entire data volume avoids losing WAL state. More advanced live backups should use SQLite's backup facilities. Docker documents the [volume backup/restore pattern](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes).

Restore to a **fresh Docker host or new, empty target volumes**, with the application stopped and the matching source/configuration already copied there. Do not extract over a live or non-empty SQLite volume. On the Linux host, set the absolute backup directory and restore:

```sh
backup_dir=/absolute/path/to/your/backup
for volume in mockie_data litellm_auth mockie_caddy_data mockie_caddy_config mockie_runner_queue; do
  test -f "$backup_dir/$volume.tgz" || continue
  docker volume create "$volume"
  docker run --rm --network none --mount "type=volume,src=$volume,dst=/target" --mount "type=bind,src=$backup_dir,dst=/backup,readonly" busybox:1.37 tar -xzf "/backup/$volume.tgz" -C /target
done
```

Restore `.env` and `infra/` to the repository before starting. These commands preserve archived numeric ownership; the normal initialization services also prepare queue/auth permissions. Start in the appropriate mode, inspect logs, check `/api/health`, reopen a session, and perform a small code run. Restored in-flight processing jobs become recoverable errors rather than being replayed. Keep the old deployment stopped: starting both against the same OAuth account from separate token copies risks refresh conflicts. Re-login if the saved refresh token is stale. Restoring Caddy data preserves its root; a new root requires reinstalling trust on every client.

## Updates

Back up first, note the current Git revision/images, and end active interviews. Inspect the new revision's changes before applying them. From a clean deployment checkout:

```sh
git pull --ff-only
docker compose --profile online pull
docker compose --profile online up -d --build
docker compose --profile online ps -a
docker compose --profile online logs --tail=100 app runner litellm caddy
```

Omit `--profile online` for offline installations. `pull` updates image-backed services; `--build` rebuilds local app/runner/proxy images. To refresh base layers or deliberately change `LITELLM_VERSION`, build with `docker compose --profile online build --pull` first; build both proxy and login images with the same version. Pinned tags/versions do not track upstream releases automatically. Verify HTTPS, history, Python and JavaScript runs, and a typed online reply where applicable. Keep the pre-update backup for rollback; a source rollback alone may not reverse data migrations. Do not delete data volumes during updates.

## Troubleshooting

| Symptom | Check/action |
| --- | --- |
| Caddy will not start / port in use | `docker compose logs caddy`; check TCP 443 conflicts or use `MOCKIE_PORT=8443` and the matching browser URL. |
| Name fails to resolve | Check local DNS/hosts, DHCP reservation, VPN/secure DNS, and stale IPv6 records. Use the configured hostname. |
| Certificate warning after rebuild | Verify the client has this deployment's root and that `mockie_caddy_data` survived. Re-extract/compare fingerprints if the CA changed. |
| Mic blocked or unavailable | Check trusted HTTPS, `window.isSecureContext`, browser/site and OS permissions, speech API support, and browser service access. Type instead when unsupported. |
| Online mode has no replies | Check `docker compose --profile online logs litellm app`, login before proxy startup, restart proxy after login, and check actual model entitlement. Try a typed question. |
| `ChatGPT device-code login needs a human` / no healthy deployment | Stop the proxy, run the `login` profile interactively, then restart the proxy. Confirm both use the same writable auth volume. |
| Login prints no new code immediately | An abandoned login can impose a cooldown; wait for the running helper rather than starting many concurrent logins. Verify device-code sign-in is allowed for the account/workspace. |
| `Failed to write ChatGPT auth file` / refresh failure | Check volume ownership and writability for UID 65534; keep auth-init enabled. Re-login if refresh was revoked or the backup is stale. |
| Model not found / unsupported parameters | Replace retired/unavailable model ID in Settings; use list-form Responses input and omit all token-limit and `metadata` fields. Do not infer access from UI suggestions. |
| Changed `.env` but model/key unchanged | Recreate containers with `up -d`; saved SQLite settings override environment defaults. Update the persisted setting too. |
| Runner unhealthy / run returns unavailable | `docker compose logs runner runner-queue-init`; check Linux image, heartbeat, queue ownership, disk space, and unchanged isolation settings. Health command is `node dist/index.js healthcheck`. |
| LXC reports permission/overlay/cgroup errors | Confirm unprivileged CT features and compatible storage/runtime; use the QEMU VM route rather than weakening isolation. |
| Run succeeds without output | Call the starter function and print/assert a result; Mockie executes a script, not a hidden test suite. |
| Run times out or output truncates | Reduce work/output or adjust documented limits within bounds. A job cannot extend the worker's wall limit. |
| Monaco is difficult on mobile | Select **Use plain editor**; typed input remains available. |
| History appears missing | Verify the same `mockie_data` volume and `DATABASE_PATH=/data/mockie.db`; do not create a replacement database before checking backups. |

Useful read-only checks:

```sh
docker compose --profile online ps -a
docker compose --profile online logs --tail=150 app runner litellm caddy
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(console.log)"
docker compose exec runner node dist/index.js healthcheck
docker compose exec litellm python -c "from pathlib import Path; import os; p=Path('/auth/chatgpt/auth.json'); print('exists:',p.exists(),'writable:',os.access(p,os.W_OK))"
```

The last check needs the online service; it prints file status, not credentials. Do not paste token files or unredacted environment/settings output into issue reports. The API health check confirms the app responds; Caddy's health check validates configuration; neither proves successful code execution or a model round trip.

## Development and verification

Use Node.js **22 or newer** and npm. Native `better-sqlite3` may need platform build prerequisites if a prebuilt binary is unavailable. Start with:

```sh
npm ci
npm run build -w @mockie/core
npm run dev:server
```

In a second terminal run `npm run dev:web` and open `http://localhost:5173`. Vite proxies `/api` and `/ws` to `localhost:3000`. The server defaults to offline mode, `./.mockie/mockie.db`, and `./.mockie/runner-queue` relative to its working directory. Set explicit paths/environment values when coordinating processes. Direct Node processes do not read Compose's `.env` automatically. Localhost HTTP is useful for development; use the Caddy path for other LAN devices.

**The production runner requires Linux and a root supervisor.** `npm run dev` launches server, web, and runner together, but the runner cannot run natively on Windows/macOS or as a normal unprivileged host process. Do not run candidate programs directly on your workstation merely to satisfy this script. For safe full execution, use the Compose stack and rebuild after changes, or connect a development app to the isolated Linux worker through a deliberately configured shared queue. Unit tests use injected execution and can run cross-platform.

| Command | Purpose |
| --- | --- |
| `npm run dev:server` | Watch the Fastify source. |
| `npm run dev:web` | Start Vite on port 5173. |
| `npm run dev:runner` | Watch worker source; requires the Linux supervisor environment. |
| `npm test` | Workspace tests plus root Compose contract tests. |
| `npm run test:coverage` | Workspace coverage reports. |
| `npm run typecheck` | Workspace TypeScript checks. |
| `npm run build` | Core, web, server, and runner production builds. |
| `npm run verify` | Tests, type checks, and production build. |
| `npm start` | Start the built server, not the whole stack. |
| `npm run test -w @mockie/server` | Run one workspace's tests. |

For the Linux runner integration suite, build and invoke the actual sandbox image with its isolation controls (from the repository root):

```sh
docker build -f apps/runner/Dockerfile -t mockie-runner .
docker run --rm --init --network none --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges --pids-limit 64 --memory 256m --memory-swap 256m --cpus 0.5 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m mockie-runner node scripts/linux-integration.mjs
```

This suite exercises real Python/Node subprocesses, UID/capability changes, `prlimit`, process cleanup, and queue protections. `npm run test:linux -w @mockie/runner` invokes the same script only when already in a suitable built Linux environment. Docker/Compose, TLS trust, microphone support, Proxmox nesting, and live OAuth still require checks on the target deployment; a unit-test pass alone does not verify them.

## Repository map

```text
apps/
  web/                 React/Vite room, Monaco, voice adapter, UI tests
  server/              Fastify API/WebSocket, SQLite, engine, provider, queue client
  runner/              Linux worker, isolation code, image, integration tests
packages/
  core/                Shared contracts, timing policy, prompts, problems, scorecards
infra/
  caddy/Caddyfile      LAN HTTPS and reverse proxy
  litellm/             Pinned provider image and Responses-mode model routing
tests/                 Compose/deployment contract tests
docs/superpowers/specs/ Design specification and operating intent
compose.yaml           Services, profiles, volumes, isolation, health checks
.env.example           Deployment defaults; copy to private .env
Dockerfile             App build and non-root runtime
```

The [design specification](docs/superpowers/specs/2026-10-22-mockie-design.md) explains the interview policy, product goals, and boundaries. The implementation and deployment files are the authority for current commands and limits.

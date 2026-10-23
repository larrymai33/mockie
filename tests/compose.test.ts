import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ComposeService = {
  cap_add?: string[];
  cap_drop?: string[];
  depends_on?: Record<string, unknown>;
  healthcheck?: Record<string, unknown>;
  init?: boolean;
  mem_limit?: number | string;
  network_mode?: string;
  pids_limit?: number;
  ports?: unknown[];
  read_only?: boolean;
  security_opt?: string[];
  tmpfs?: unknown[];
  volumes?: Array<{ source?: string; target?: string; type?: string }>;
};

type ComposeConfig = {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};

function effectiveComposeConfig(): ComposeConfig {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.example",
      "--profile",
      "online",
      "--profile",
      "login",
      "config",
      "--format",
      "json"
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, LITELLM_MASTER_KEY: "test-only-not-a-deployment-secret" }
    }
  );
  return JSON.parse(output) as ComposeConfig;
}

describe("production compose security contract", () => {
  it("keeps candidate execution in a bounded networkless worker", () => {
    const runner = effectiveComposeConfig().services.runner;

    expect(runner).toMatchObject({
      init: true,
      network_mode: "none",
      read_only: true,
      pids_limit: 64
    });
    expect(runner?.cap_drop).toContain("ALL");
    expect(runner?.cap_add).toEqual(expect.arrayContaining(["SETUID", "SETGID", "KILL"]));
    expect(runner?.security_opt).toContain("no-new-privileges:true");
    expect(runner?.mem_limit).toBeTruthy();
    expect(runner?.tmpfs).toBeTruthy();
  });

  it("publishes only the TLS entrypoint", () => {
    const services = effectiveComposeConfig().services;
    const published = Object.entries(services)
      .filter(([, service]) => (service.ports?.length ?? 0) > 0)
      .map(([name]) => name);

    expect(published).toEqual(["caddy"]);
    expect(services.caddy?.ports).toEqual([
      expect.objectContaining({ host_ip: "192.168.1.50", target: 443 })
    ]);
  });

  it("hardens the application container and waits for an enabled model proxy", () => {
    const app = effectiveComposeConfig().services.app;
    expect(app).toMatchObject({ read_only: true, cap_drop: ["ALL"] });
    expect(app?.security_opt).toContain("no-new-privileges:true");
    expect(app?.tmpfs).toBeTruthy();
    expect(app?.depends_on).toMatchObject({
      litellm: { condition: "service_healthy", required: false }
    });
  });

  it("persists app data, OAuth credentials, TLS state, and the runner queue", () => {
    const config = effectiveComposeConfig();

    expect(Object.keys(config.volumes)).toEqual(
      expect.arrayContaining([
        "mockie_data",
        "litellm_auth",
        "caddy_data",
        "caddy_config",
        "runner_queue"
      ])
    );
    expect(config.services.app?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "mockie_data", target: "/data" }),
        expect.objectContaining({ source: "runner_queue", target: "/queue" })
      ])
    );
    expect(config.services.litellm?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "litellm_auth", target: "/auth" })
      ])
    );
  });

  it("defines health checks for every long-running service", () => {
    const services = effectiveComposeConfig().services;
    for (const name of ["app", "runner", "litellm", "caddy"] as const) {
      expect(services[name]?.healthcheck, `${name} healthcheck`).toBeTruthy();
    }
  });

  it("keeps secrets, host dependencies, and generated state out of image builds", () => {
    const ignored = readFileSync(".dockerignore", "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(ignored).toMatch(/^\.env\*?$/m);
    expect(ignored).toMatch(/^node_modules\/$/m);
    expect(ignored).toMatch(/^\.mockie\/$/m);
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s+\.$/m);
  });
});

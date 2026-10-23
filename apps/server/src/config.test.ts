import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses safe local defaults", () => {
    expect(loadConfig({})).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      providerMode: "offline",
      model: "chatgpt/gpt-5.4",
      defaultDurationMinutes: 45
    });
  });

  it("rejects malformed numeric environment values", () => {
    expect(() => loadConfig({ PORT: "NaN" })).toThrow("Invalid server configuration");
    expect(() => loadConfig({ MOCKIE_SESSION_MINUTES: "3" })).toThrow("Invalid server configuration");
  });
});

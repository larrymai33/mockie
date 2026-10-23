import { OfflineProvider, type Session } from "@mockie/core";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LiteLLMProvider } from "./providers/litellm.js";
import { SessionRepository } from "./repository.js";
import { QueueRunner } from "./runner-client.js";

const config = loadConfig(process.env);
const repository = new SessionRepository(config.databasePath, {
  providerMode: config.providerMode,
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  model: config.model,
  defaultDurationMinutes: config.defaultDurationMinutes,
  autoSpeak: true,
  autoListen: true
});
const offlineProvider = new OfflineProvider();
const providerForSession = (session: Session) => {
  if (session.providerMode === "offline") return offlineProvider;
  const settings = repository.getSettings();
  return new LiteLLMProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model
  });
};
const runner = new QueueRunner({ queuePath: config.queuePath });
const app = buildApp({
  repository,
  runner,
  providerForSession,
  webDistPath: config.webDistPath,
  logger: true
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

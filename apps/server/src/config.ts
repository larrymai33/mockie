import { z } from "zod";

const schema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  databasePath: z.string().min(1),
  queuePath: z.string().min(1),
  providerMode: z.enum(["offline", "online"]),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  defaultDurationMinutes: z.number().int().min(10).max(180),
  webDistPath: z.string().min(1)
});

export type ServerConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): ServerConfig {
  const parsed = schema.safeParse({
    host: environment.HOST ?? "0.0.0.0",
    port: Number(environment.PORT ?? 3000),
    databasePath: environment.DATABASE_PATH ?? "./.mockie/mockie.db",
    queuePath: environment.RUNNER_QUEUE_PATH ?? "./.mockie/runner-queue",
    providerMode: environment.MOCKIE_MODE ?? "offline",
    baseUrl: environment.LITELLM_BASE_URL ?? "http://litellm:4000",
    apiKey: environment.LITELLM_MASTER_KEY ?? "",
    model: environment.MOCKIE_MODEL ?? "chatgpt/gpt-5.4",
    defaultDurationMinutes: Number(environment.MOCKIE_SESSION_MINUTES ?? 45),
    webDistPath: environment.WEB_DIST_PATH ?? "../web/dist"
  });
  if (!parsed.success) {
    throw new Error(`Invalid server configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

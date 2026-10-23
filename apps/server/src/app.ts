import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import {
  builtInProblems,
  getProblem,
  type InterviewProvider,
  type Language,
  type Problem,
  type Session
} from "@mockie/core";
import { InterviewEngine, SessionEndingError } from "./engine.js";
import type { CodeRunner } from "./runner-client.js";
import { type ServerSettings, SessionRepository, type StoredEvent } from "./repository.js";

interface SocketLike {
  readyState: number;
  send(data: string): void;
  on(event: "close", listener: () => void): void;
}

export interface BuildAppOptions {
  repository: SessionRepository;
  runner: CodeRunner;
  provider?: InterviewProvider;
  providerForSession?: (session: Session) => InterviewProvider;
  startScheduler?: boolean;
  webDistPath?: string;
  logger?: boolean;
}

const languageSchema = z.enum(["python", "javascript"]);
const createSessionSchema = z.object({
  problemId: z.string().min(1).optional(),
  customProblem: z
    .object({
      title: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(20_000),
      constraints: z.array(z.string().trim().min(1)).max(30).optional(),
      starterCode: z.object({ python: z.string(), javascript: z.string() }).optional()
    })
    .optional(),
  language: languageSchema,
  durationMinutes: z.number().int().min(10).max(180),
  mode: z.enum(["offline", "online"]).optional()
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("candidate_message"),
    text: z.string().trim().min(1).max(10_000),
    source: z.enum(["voice", "typed"])
  }),
  z.object({
    type: z.literal("code_change"),
    code: z.string().max(200_000),
    revision: z.number().int().nonnegative()
  })
]);
const runSchema = z.object({
  language: languageSchema,
  code: z.string().max(200_000),
  stdin: z.string().max(100_000).optional()
});

function customProblem(input: z.infer<typeof createSessionSchema>["customProblem"]): Problem | null {
  if (!input) return null;
  return {
    id: `custom-${crypto.randomUUID()}`,
    title: input.title,
    difficulty: "custom",
    description: input.description,
    constraints: input.constraints ?? [],
    examples: [],
    starterCode:
      input.starterCode ??
      ({
        python: "def solve():\n    pass\n",
        javascript: "function solve() {\n  // Start here.\n}\n"
      } satisfies Record<Language, string>)
  };
}

function clientSettings(settings: ServerSettings): Omit<ServerSettings, "apiKey"> {
  const { apiKey: _apiKey, ...safe } = settings;
  return safe;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 512_000 });
  const clients = new Map<string, Set<SocketLike>>();
  const broadcast = (sessionId: string, value: unknown): void => {
    const message = JSON.stringify(value);
    for (const socket of clients.get(sessionId) ?? []) {
      if (socket.readyState === 1) socket.send(message);
    }
  };
  const broadcastEvent = (event: StoredEvent): void => {
    broadcast(event.sessionId, { type: "event", event });
  };
  const engine = new InterviewEngine({
    repository: options.repository,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.providerForSession === undefined ? {} : { providerForSession: options.providerForSession }),
    onEvent: broadcastEvent
  });

  app.register(fastifyWebsocket);
  app.register(async (websocketRoutes) => {
    websocketRoutes.get<{ Querystring: { sessionId?: string } }>("/ws", { websocket: true }, (socket, request) => {
      const sessionId = request.query.sessionId;
      if (!sessionId || !options.repository.getSession(sessionId)) {
        socket.close(1008, "Unknown session");
        return;
      }
      const typedSocket = socket as SocketLike;
      const set = clients.get(sessionId) ?? new Set<SocketLike>();
      set.add(typedSocket);
      clients.set(sessionId, set);
      socket.on("close", () => {
        set.delete(typedSocket);
        if (set.size === 0) clients.delete(sessionId);
      });
    });
  });

  app.get("/api/health", async () => ({ ok: true, service: "mockie" }));
  app.get("/api/problems", async () => ({ problems: builtInProblems }));
  app.get("/api/settings", async () => clientSettings(options.repository.getSettings()));
  app.patch("/api/settings", async (request, reply) => {
    const schema = z
      .object({
        providerMode: z.enum(["offline", "online"]).optional(),
        baseUrl: z.string().url().optional(),
        model: z.string().trim().min(1).max(200).optional(),
        apiKey: z.string().max(500).optional(),
        defaultDurationMinutes: z.number().int().min(10).max(180).optional(),
        autoSpeak: z.boolean().optional(),
        autoListen: z.boolean().optional()
      })
      .strict();
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid settings", details: parsed.error.flatten() });
    return clientSettings(options.repository.updateSettings(parsed.data as Partial<ServerSettings>));
  });

  app.get("/api/sessions", async () => ({ sessions: options.repository.listSessions() }));
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = options.repository.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return { session, events: options.repository.listEvents(session.id) };
  });

  app.post("/api/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid session", details: parsed.error.flatten() });
    const settings = options.repository.getSettings();
    const problem = customProblem(parsed.data.customProblem) ?? (parsed.data.problemId ? getProblem(parsed.data.problemId) : undefined);
    if (!problem) return reply.code(400).send({ error: "Choose a built-in problem or provide a custom problem" });
    const session = options.repository.createSession({
      problem,
      language: parsed.data.language,
      providerMode: parsed.data.mode ?? settings.providerMode,
      durationMinutes: parsed.data.durationMinutes
    });
    const event = options.repository.appendEvent(session.id, {
      type: "session_started",
      role: "system",
      payload: {},
      createdAt: session.startedAt
    });
    broadcastEvent(event);
    return reply.code(201).send({ session });
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/events", async (request, reply) => {
    const session = options.repository.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.status !== "active") return reply.code(409).send({ error: "Session has ended" });
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid event", details: parsed.error.flatten() });
    if (parsed.data.type === "code_change" && parsed.data.code === session.code) {
      return reply.code(202).send({ accepted: true, unchanged: true });
    }
    const event =
      parsed.data.type === "candidate_message"
        ? {
            type: "candidate_message" as const,
            role: "candidate" as const,
            payload: { text: parsed.data.text, source: parsed.data.source },
            createdAt: new Date().toISOString()
          }
        : {
            type: "code_change" as const,
            role: "candidate" as const,
            payload: { code: parsed.data.code, revision: Math.max(parsed.data.revision, session.codeRevision + 1) },
            createdAt: new Date().toISOString()
          };
    try {
      await engine.acceptEvent(session.id, event);
    } catch (error) {
      if (error instanceof SessionEndingError) return reply.code(409).send({ error: "Session is ending" });
      throw error;
    }
    broadcast(session.id, { type: "session", session: options.repository.getSession(session.id) });
    return reply.code(202).send({ accepted: true });
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/run", async (request, reply) => {
    const session = options.repository.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.status !== "active") return reply.code(409).send({ error: "Session has ended" });
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid run", details: parsed.error.flatten() });
    if (parsed.data.language !== session.language) return reply.code(400).send({ error: "Run language must match the session" });
    try {
      const result = await options.runner.run({
        sessionId: session.id,
        language: parsed.data.language,
        code: parsed.data.code,
        ...(parsed.data.stdin === undefined ? {} : { stdin: parsed.data.stdin })
      });
      options.repository.saveRun(result);
      await engine.acceptEvent(session.id, {
        type: "run_result",
        role: "system",
        payload: { ...result },
        createdAt: result.completedAt
      });
      broadcast(session.id, { type: "session", session: options.repository.getSession(session.id) });
      return { run: result };
    } catch {
      const event = options.repository.appendEvent(session.id, {
        type: "system_status",
        role: "system",
        payload: {
          level: "error",
          recoverable: true,
          source: "runner",
          message: "The code runner is unavailable. Your session and code are still saved."
        },
        createdAt: new Date().toISOString()
      });
      broadcastEvent(event);
      return reply.code(503).send({
        error: "The code runner is unavailable. Try again in a moment.",
        recoverable: true,
        source: "runner"
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/end", async (request, reply) => {
    const session = options.repository.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (session.status === "ended") return { session, scorecard: session.scorecard };
    const ended = await engine.endSession(session.id);
    broadcast(session.id, { type: "session", session: ended });
    return { session: ended, scorecard: ended.scorecard };
  });

  if (options.startScheduler !== false) {
    const timer = setInterval(() => {
      for (const session of options.repository.listActiveSessions()) void engine.tick(session.id);
    }, 1_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  app.addHook("onClose", async () => options.repository.close());

  const webRoot = options.webDistPath ? resolve(options.webDistPath) : null;
  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

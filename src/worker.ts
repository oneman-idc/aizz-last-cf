import { handleRequest } from "./api";
import type { Env } from "./types";
import initialSchema from "../migrations/0001_initial.sql";

let schemaReady: Promise<void> | undefined;

async function initializeSchema(env: Env): Promise<void> {
  const existing = await env.AIZZ_DB.prepare(
    "SELECT 1 AS ready FROM sqlite_master WHERE type='table' AND name='users' LIMIT 1",
  ).first();
  if (existing) return;

  const statements = initialSchema
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (!statements.length) throw new Error("D1 初始化 SQL 为空");
  await env.AIZZ_DB.batch(statements.map((statement) => env.AIZZ_DB.prepare(statement)));
}

function hasD1Binding(env: Env): boolean {
  return Boolean(env.AIZZ_DB && typeof env.AIZZ_DB.prepare === "function" && typeof env.AIZZ_DB.batch === "function");
}

function ensureSchema(env: Env): Promise<void> {
  schemaReady ??= initializeSchema(env).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      if (!hasD1Binding(env)) {
        return Response.json(
          {
            error: "当前 Worker 未绑定 D1 数据库。请创建 D1 数据库，并使用变量名 AIZZ_DB 绑定到此 Worker。",
            code: "D1_BINDING_MISSING",
          },
          { status: 503 },
        );
      }
      try {
        await ensureSchema(env);
      } catch (error) {
        const requestId = crypto.randomUUID();
        console.error("AIZZ Edge schema initialization failed", requestId, error);
        return Response.json(
          {
            error: "AIZZ_DB 已绑定，但数据库表结构初始化失败。",
            code: "D1_SCHEMA_INIT_FAILED",
            details: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            request_id: requestId,
          },
          { status: 503 },
        );
      }
      return handleRequest(request, env, (promise) => context.waitUntil(promise));
    }
    return env.ASSETS.fetch(request);
  },
};

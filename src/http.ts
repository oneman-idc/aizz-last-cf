export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY",
      ...headers,
    },
  });
}

export async function bodyJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "请求必须使用 application/json");
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new HttpError(400, "JSON 请求内容无效");
  }
}

export function integer(value: unknown, label: string, minimum = 1): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new HttpError(400, `${label}无效`);
  return result;
}

export function text(value: unknown, maximum = 500): string {
  return String(value ?? "").trim().slice(0, maximum);
}

export function now(): string {
  return new Date().toISOString();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export function remoteIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "";
}

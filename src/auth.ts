import { hashPassword, hmacHex, PASSWORD_ITERATIONS, randomToken, validatePassword, verifyPassword } from "./crypto";
import { HttpError, now, remoteIp } from "./http";
import type { Env, SessionUser, User } from "./types";

export const SESSION_COOKIE = "aizz_edge_session";
const SESSION_SECONDS = 8 * 60 * 60;

function cookieValue(request: Request, name: string): string {
  const source = request.headers.get("cookie") || "";
  for (const item of source.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

export function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  const value = maxAge > 0 ? encodeURIComponent(token) : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function ensureInitialAdmin(env: Env): Promise<boolean> {
  const existing = await env.AIZZ_DB.prepare(
    "SELECT id,username,password_hash,force_password_change,last_login_at FROM users ORDER BY id LIMIT 1",
  ).first<{ id: number; username: string; password_hash: string; force_password_change: number; last_login_at: string | null }>();
  if (existing) {
    const iterations = Number(existing.password_hash.split("$")[1] || 0);
    const unfinishedBootstrap = existing.username.toLowerCase() === "admin"
      && Boolean(existing.force_password_change) && !existing.last_login_at;
    if (!unfinishedBootstrap || iterations <= PASSWORD_ITERATIONS) return false;

    const password = env.INITIAL_ADMIN_PASSWORD || "";
    const error = validatePassword(password);
    if (error) throw new HttpError(503, `INITIAL_ADMIN_PASSWORD 配置无效：${error}`);
    await env.AIZZ_DB.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?")
      .bind(await hashPassword(password), now(), existing.id).run();
    return true;
  }
  const password = env.INITIAL_ADMIN_PASSWORD || "";
  const error = validatePassword(password);
  if (error) throw new HttpError(503, `INITIAL_ADMIN_PASSWORD 配置无效：${error}`);
  const timestamp = now();
  await env.AIZZ_DB.prepare(
    "INSERT OR IGNORE INTO users(username,password_hash,display_name,role,active,force_password_change,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)",
  ).bind("admin", await hashPassword(password), "系统管理员", "admin", timestamp, timestamp).run();
  return true;
}

export async function authenticate(request: Request, env: Env): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !env.SESSION_SECRET) return null;
  const id = await hmacHex(env.SESSION_SECRET, token);
  const row = await env.AIZZ_DB.prepare(
    `SELECT users.id,users.username,users.display_name,users.role,users.active,
            users.force_password_change,sessions.csrf_token
       FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.id=? AND sessions.expires_at>? AND users.active=1`,
  ).bind(id, now()).first<SessionUser>();
  return row || null;
}

export async function requireUser(request: Request, env: Env, roles?: User["role"][]): Promise<SessionUser> {
  const user = await authenticate(request, env);
  if (!user) throw new HttpError(401, "请先登录");
  if (roles && !roles.includes(user.role)) throw new HttpError(403, "当前账号没有此操作权限");
  if (request.method !== "GET" && request.method !== "HEAD") {
    const csrf = request.headers.get("X-AIZZ-CSRF") || "";
    if (!csrf || csrf !== user.csrf_token) throw new HttpError(403, "安全校验失败，请刷新页面后重试");
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "禁止跨站写入请求");
  }
  return user;
}

export async function login(
  request: Request, env: Env, username: string, password: string,
): Promise<{ user: SessionUser; cookie: string }> {
  const bootstrapPasswordPrepared = await ensureInitialAdmin(env);
  const ip = remoteIp(request) || "unknown";
  const attempt = await env.AIZZ_DB.prepare(
    "SELECT attempts,window_started_at,blocked_until FROM login_attempts WHERE ip_address=?",
  ).bind(ip).first<{ attempts: number; window_started_at: string; blocked_until: string | null }>();
  const currentTime = now();
  if (attempt?.blocked_until && attempt.blocked_until > currentTime) {
    throw new HttpError(429, "登录失败次数过多，请 15 分钟后重试");
  }
  const row = await env.AIZZ_DB.prepare(
    "SELECT id,username,password_hash,display_name,role,active,force_password_change FROM users WHERE username=? COLLATE NOCASE",
  ).bind(username).first<User & { password_hash: string }>();
  const bootstrapPasswordMatches = bootstrapPasswordPrepared
    && username.toLowerCase() === "admin" && password === env.INITIAL_ADMIN_PASSWORD;
  if (!row || !row.active || (!bootstrapPasswordMatches && !(await verifyPassword(row.password_hash, password)))) {
    const windowExpired = !attempt || Date.parse(attempt.window_started_at) < Date.now() - 15 * 60 * 1000;
    const attempts = windowExpired ? 1 : Number(attempt.attempts || 0) + 1;
    const blockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await env.AIZZ_DB.prepare(
      `INSERT INTO login_attempts(ip_address,attempts,window_started_at,blocked_until,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(ip_address) DO UPDATE SET attempts=excluded.attempts,window_started_at=excluded.window_started_at,
       blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`,
    ).bind(ip, attempts, windowExpired ? currentTime : attempt!.window_started_at, blockedUntil, currentTime).run();
    throw new HttpError(401, "用户名或密码错误");
  }
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const id = await hmacHex(env.SESSION_SECRET, token);
  const timestamp = now();
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.AIZZ_DB.batch([
    env.AIZZ_DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(timestamp),
    env.AIZZ_DB.prepare("INSERT INTO sessions(id,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)")
      .bind(id, row.id, csrfToken, expires, timestamp),
    env.AIZZ_DB.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE id=?").bind(timestamp, timestamp, row.id),
    env.AIZZ_DB.prepare("DELETE FROM login_attempts WHERE ip_address=?").bind(ip),
  ]);
  const user: SessionUser = { ...row, csrf_token: csrfToken };
  delete (user as Partial<typeof row>).password_hash;
  await audit(env, request, user, "auth.login", "user", String(row.id));
  return { user, cookie: sessionCookie(token) };
}

export async function logout(request: Request, env: Env, user: SessionUser): Promise<string> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await env.AIZZ_DB.prepare("DELETE FROM sessions WHERE id=?").bind(await hmacHex(env.SESSION_SECRET, token)).run();
  await audit(env, request, user, "auth.logout", "user", String(user.id));
  return sessionCookie("", 0);
}

export async function audit(
  env: Env, request: Request, user: Pick<User, "id" | "username"> | null,
  action: string, targetType = "", targetId = "", detail: unknown = {},
): Promise<void> {
  await env.AIZZ_DB.prepare(
    "INSERT INTO audit_logs(user_id,username,action,target_type,target_id,detail_json,ip_address,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).bind(user?.id || null, user?.username || "", action, targetType, targetId,
    JSON.stringify(detail), remoteIp(request), now()).run();
}

import { audit, authenticate, ensureInitialAdmin, login, logout, requireUser, sessionCookie } from "./auth";
import { decryptSecret, encryptSecret, hashPassword, sha256, validatePassword, verifyPassword } from "./crypto";
import { bodyJson, HttpError, integer, json, now, parseJson, text } from "./http";
import { processNextDeployment } from "./services/deploy";
import { BtClient, CloudflareClient, credentialClient } from "./services/integrations";
import type { ApiCredential, Env, ResourceMapping, SessionUser, User, WaitUntil } from "./types";

const MAX_UPLOAD = 20 * 1024 * 1024;

function publicUser(user: SessionUser | User): Record<string, unknown> {
  return {
    id: user.id, username: user.username, display_name: user.display_name, role: user.role,
    active: user.active, force_password_change: user.force_password_change,
    csrf_token: "csrf_token" in user ? user.csrf_token : undefined,
  };
}

function routeId(path: string, pattern: RegExp): number | null {
  const match = path.match(pattern);
  return match ? Number(match[1]) : null;
}

async function credential(env: Env, id: number): Promise<ApiCredential> {
  const row = await env.AIZZ_DB.prepare(
    "SELECT id,kind,name,base_url,secret_data,extra_json,enabled FROM api_credentials WHERE id=?",
  ).bind(id).first<ApiCredential>();
  if (!row) throw new HttpError(404, "API 配置不存在");
  return row;
}

async function dashboard(env: Env): Promise<Response> {
  const [sources, materials, batches, credentials] = await env.AIZZ_DB.batch([
    env.AIZZ_DB.prepare("SELECT kind,COUNT(*) count FROM resource_packages GROUP BY kind"),
    env.AIZZ_DB.prepare("SELECT status,COUNT(*) count FROM site_materials GROUP BY status"),
    env.AIZZ_DB.prepare("SELECT * FROM deployment_batches ORDER BY id DESC LIMIT 8"),
    env.AIZZ_DB.prepare("SELECT id,kind,name,last_test_status,last_test_message,last_test_at FROM api_credentials WHERE enabled=1 ORDER BY kind,id"),
  ]);
  return json({
    resources: sources.results, materials: materials.results,
    batches: batches.results, credentials: credentials.results,
  });
}

async function saveIntegration(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const kind = text(body.kind, 20);
  const name = text(body.name, 100);
  const baseUrl = text(body.base_url, 500);
  const secret = text(body.secret, 5000);
  if (!['bt', 'cloudflare'].includes(kind) || !name || !secret) throw new HttpError(400, "API 类型、名称和密钥均为必填项");
  if (kind === "bt" && !baseUrl) throw new HttpError(400, "BT 面板 HTTPS 地址不能为空");
  let secretValue = secret.replace(/^Bearer\s+/i, "");
  const extra: Record<string, string> = {};
  if (kind === "bt") {
    extra.access_client_id = text(body.access_client_id, 300);
    secretValue = JSON.stringify({ api_key: secret, access_client_secret: text(body.access_client_secret, 1000) });
  } else {
    extra.account_id = text(body.account_id, 100);
  }
  const timestamp = now();
  let result: D1Result;
  try {
    result = await env.AIZZ_DB.prepare(
      `INSERT INTO api_credentials(kind,name,base_url,secret_data,extra_json,enabled,created_at,updated_at)
       VALUES(?,?,?,?,?,1,?,?)`,
    ).bind(kind, name, baseUrl, await encryptSecret(secretValue, env.MASTER_KEY), JSON.stringify(extra), timestamp, timestamp).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "同类型 API 配置名称已存在");
    throw error;
  }
  await audit(env, request, user, "integration.create", "api_credential", String(result.meta.last_row_id), { kind, name });
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function testIntegration(request: Request, env: Env, user: SessionUser, id: number, environment = false): Promise<Response> {
  const row = await credential(env, id);
  let status = "success";
  let message = "连接成功";
  let result: unknown;
  try {
    const client = await credentialClient(env, row);
    if (environment) {
      if (!(client instanceof BtClient)) throw new HttpError(400, "只有 BT 配置支持读取运行环境");
      result = await client.environment();
      message = "BT 运行环境读取完成";
    } else if (client instanceof BtClient || client instanceof CloudflareClient) {
      result = await client.test();
      message = String((result as Record<string, unknown>).message || message);
    }
  } catch (error) {
    status = "failed";
    message = error instanceof Error ? error.message : String(error);
  }
  await env.AIZZ_DB.prepare(
    "UPDATE api_credentials SET last_test_status=?,last_test_message=?,last_test_at=?,updated_at=? WHERE id=?",
  ).bind(status, message.slice(0, 1000), now(), now(), id).run();
  await audit(env, request, user, "integration.test", "api_credential", String(id), { status, environment });
  if (status === "failed") throw new HttpError(502, message);
  return json({ ok: true, message, result });
}

async function saveDatabase(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const name = text(body.name, 100);
  const dbType = text(body.db_type, 20);
  if (!name || !['mysql', 'redis', 'sqlite'].includes(dbType)) throw new HttpError(400, "数据源名称或类型无效");
  const timestamp = now();
  const result = await env.AIZZ_DB.prepare(
    `INSERT INTO remote_databases(name,db_type,host,port,database_name,username,secret_data,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).bind(name, dbType, text(body.host, 300), body.port ? integer(body.port, "端口") : null,
    text(body.database_name, 500), text(body.username, 200),
    await encryptSecret(text(body.password, 2000), env.MASTER_KEY), timestamp, timestamp).run();
  await audit(env, request, user, "database.create", "remote_database", String(result.meta.last_row_id), { name, db_type: dbType });
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

function validateMappings(raw: string): ResourceMapping[] {
  const mappings = parseJson<ResourceMapping[]>(raw, []);
  if (!Array.isArray(mappings) || mappings.length > 200) throw new HttpError(400, "字段映射必须是最多 200 项的 JSON 数组");
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object" || !text(mapping.marker, 500) || !text(mapping.source, 100)) {
      throw new HttpError(400, "每个字段映射必须包含 marker 和 source");
    }
    if (mapping.path && (mapping.path.startsWith("/") || mapping.path.includes(".."))) throw new HttpError(400, "字段映射文件路径无效");
  }
  return mappings;
}

async function uploadResource(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".zip")) throw new HttpError(400, "请选择 ZIP 源码包");
  if (!file.size || file.size > MAX_UPLOAD) throw new HttpError(413, "Edge 版单个源码 ZIP 必须小于 20MB");
  const kind = text(form.get("kind"), 20);
  const name = text(form.get("name"), 120);
  if (!['source', 'template', 'plugin'].includes(kind) || !name) throw new HttpError(400, "资源类型或名称无效");
  const mappings = validateMappings(text(form.get("mapping_json"), 100_000) || "[]");
  const bytes = await file.arrayBuffer();
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) throw new HttpError(400, "上传文件不是有效 ZIP");
  const checksum = await sha256(bytes);
  const objectKey = `resources/${kind}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  await env.AIZZ_STORAGE.put(objectKey, bytes, { httpMetadata: { contentType: "application/zip" } });
  try {
    const timestamp = now();
    const result = await env.AIZZ_DB.prepare(
      `INSERT INTO resource_packages(kind,name,version,object_key,archive_name,checksum,size_bytes,mapping_json,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(kind, name, text(form.get("version"), 50) || "unknown", objectKey, file.name, checksum,
      file.size, JSON.stringify(mappings), user.id, timestamp, timestamp).run();
    await audit(env, request, user, "resource.create", "resource", String(result.meta.last_row_id), { kind, name, size: file.size });
    return json({ ok: true, id: result.meta.last_row_id, checksum }, 201);
  } catch (error) {
    await env.AIZZ_STORAGE.delete(objectKey);
    throw error;
  }
}

function normalizeKeyword(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function normalizeDomain(value: string): string {
  const raw = value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  if (!raw) return "";
  let domain: string;
  try { domain = new URL(`http://${raw}`).hostname; } catch { throw new HttpError(400, `域名无效：${value}`); }
  if (domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".") || domain.includes("..")) {
    throw new HttpError(400, `域名无效：${value}`);
  }
  return domain;
}

function localSeo(keyword: string): { site_name: string; title: string; description: string } {
  const siteName = `${keyword}指南`;
  const title = `${keyword} - 最新资讯、实用指南与精选内容`;
  let description = `本站围绕${keyword}整理持续更新的行业资讯、实用方法、常见问题与精选内容，帮助访问者快速理解主题背景、比较关键信息并找到可靠的参考资料。内容注重清晰结构和实际价值，同时根据用户关注方向补充相关知识、使用建议与最新动态。`;
  if (description.length < 80) description += `欢迎关注${keyword}的后续更新与详细解读。`;
  return { site_name: siteName.slice(0, 120), title: title.slice(0, 70), description: description.slice(0, 160) };
}

async function importMaterials(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const keywords = String(body.keywords || "").split(/\r?\n/).map(normalizeKeyword).filter(Boolean);
  const domains = String(body.domains || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map(normalizeDomain);
  if (!keywords.length && !domains.length) throw new HttpError(400, "请至少填写一行关键词或域名");
  if (Math.max(keywords.length, domains.length) > 100) throw new HttpError(400, "免费版每次最多导入 100 条");
  const timestamp = now();
  let keywordIndex = 0;
  let domainIndex = 0;
  const statements: D1PreparedStatement[] = [];
  if (domains.length && !keywords.length) {
    const empty = await env.AIZZ_DB.prepare(
      "SELECT id FROM site_materials WHERE domain='' AND status='available' ORDER BY id LIMIT ?",
    ).bind(domains.length).all<{ id: number }>();
    for (const row of empty.results) {
      statements.push(env.AIZZ_DB.prepare("UPDATE site_materials SET domain=?,updated_at=? WHERE id=?")
        .bind(domains[domainIndex++], timestamp, row.id));
    }
  }
  const count = Math.max(keywords.length, domains.length - domainIndex);
  for (let index = 0; index < count; index += 1) {
    const keyword = keywords[keywordIndex++] || domains[domainIndex] || "";
    const domain = domains[domainIndex++] || "";
    const seo = localSeo(keyword);
    statements.push(env.AIZZ_DB.prepare(
      "INSERT INTO site_materials(keyword,domain,site_name,title,description,status,created_at,updated_at) VALUES(?,?,?,?,?,'available',?,?)",
    ).bind(keyword, domain, seo.site_name, seo.title, seo.description, timestamp, timestamp));
  }
  try {
    if (statements.length) await env.AIZZ_DB.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "导入内容包含已存在的域名");
    throw error;
  }
  await audit(env, request, user, "materials.import", "site_material", "bulk", { keywords: keywords.length, domains: domains.length });
  return json({ ok: true, imported: statements.length });
}

function aiText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(aiText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["response", "output", "text", "content", "result"]) {
      const found = aiText(record[key]);
      if (found) return found;
    }
  }
  return "";
}

async function generateMaterials(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => integer(id, "材料 ID")) : [];
  const model = text(body.model, 200) || "@cf/meta/llama-3.1-8b-instruct";
  const query = ids.length
    ? env.AIZZ_DB.prepare(`SELECT id,keyword FROM site_materials WHERE id IN (${ids.map(() => "?").join(",")}) AND status='available' LIMIT 10`).bind(...ids)
    : env.AIZZ_DB.prepare("SELECT id,keyword FROM site_materials WHERE status='available' ORDER BY id LIMIT 10");
  const rows = (await query.all<{ id: number; keyword: string }>()).results;
  if (!rows.length) throw new HttpError(400, "没有可生成的材料；单次最多处理 10 条");
  const prompt = `你是中文 SEO 编辑。根据输入生成严格 JSON 数组，不要 Markdown 和解释。每项仅包含 id、keyword、site_name、title、description。keyword 原样返回；title 自然包含关键词且 20-70 字；description 自然包含关键词且严格 80-160 个中文字符，内容具体连贯，不堆砌关键词。输入：${JSON.stringify(rows)}`;
  const raw = await env.AI.run(model, { messages: [{ role: "user", content: prompt }] });
  const output = aiText(raw).replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) throw new HttpError(502, "Workers AI 未返回可识别的 JSON 数组，本次未写入材料");
  let generated: Array<Record<string, unknown>>;
  try { generated = JSON.parse(match[0]); } catch { throw new HttpError(502, "Workers AI 返回的 JSON 无法解析，本次未写入材料"); }
  if (!Array.isArray(generated) || generated.length !== rows.length) throw new HttpError(502, "Workers AI 返回数量不一致，本次未写入材料");
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const source = rows[index];
    const item = generated[index] || {};
    const keyword = normalizeKeyword(String(item.keyword || ""));
    const siteName = normalizeKeyword(String(item.site_name || ""));
    let title = String(item.title || "").replace(/\s+/g, " ").trim();
    let description = String(item.description || "").replace(/\s+/g, " ").trim();
    if (Number(item.id) !== source.id || keyword.toLowerCase() !== source.keyword.toLowerCase()) {
      throw new HttpError(502, `Workers AI 返回顺序与关键词“${source.keyword}”不一致，本次未写入材料`);
    }
    if (!siteName || !title || !title.toLowerCase().includes(source.keyword.toLowerCase())) {
      throw new HttpError(502, `“${source.keyword}”的网站名称或标题不符合要求，本次未写入材料`);
    }
    if (!description.toLowerCase().includes(source.keyword.toLowerCase()) || description.length < 80 || description.length > 160) {
      throw new HttpError(502, `“${source.keyword}”的描述为 ${description.length} 字，必须是 80-160 字，本次未写入材料`);
    }
    title = title.slice(0, 70);
    description = description.slice(0, 160);
    statements.push(env.AIZZ_DB.prepare(
      "UPDATE site_materials SET site_name=?,title=?,description=?,updated_at=? WHERE id=?",
    ).bind(siteName, title, description, now(), source.id));
  }
  await env.AIZZ_DB.batch(statements);
  await audit(env, request, user, "materials.ai_generate", "site_material", "bulk", { count: rows.length, model });
  return json({ ok: true, generated: rows.length });
}

async function updateMaterial(request: Request, env: Env, user: SessionUser, id: number): Promise<Response> {
  const body = await bodyJson(request);
  const existing = await env.AIZZ_DB.prepare("SELECT * FROM site_materials WHERE id=?").bind(id).first<Record<string, unknown>>();
  if (!existing) throw new HttpError(404, "网站材料不存在");
  const keyword = normalizeKeyword(text(body.keyword, 120) || String(existing.keyword));
  const domain = body.domain === undefined ? String(existing.domain) : normalizeDomain(text(body.domain, 300));
  const siteName = text(body.site_name, 120) || String(existing.site_name);
  const title = text(body.title, 70) || String(existing.title);
  const description = text(body.description, 160) || String(existing.description);
  await env.AIZZ_DB.prepare(
    "UPDATE site_materials SET keyword=?,domain=?,site_name=?,title=?,description=?,updated_at=? WHERE id=?",
  ).bind(keyword, domain, siteName, title, description, now(), id).run();
  await audit(env, request, user, "material.update", "site_material", String(id));
  return json({ ok: true });
}

async function createBatch(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const count = integer(body.count, "站点数量");
  if (count > 100) throw new HttpError(400, "免费版单批最多创建 100 个站点");
  const sourceId = integer(body.source_id, "内核源码");
  const source = await env.AIZZ_DB.prepare("SELECT id FROM resource_packages WHERE id=? AND kind='source'").bind(sourceId).first();
  if (!source) throw new HttpError(400, "所选内核源码不存在");
  const randomTemplate = Boolean(body.random_template);
  const templateId = body.template_id ? integer(body.template_id, "模板") : null;
  let templates: Array<{ id: number }> = [];
  if (randomTemplate) {
    templates = (await env.AIZZ_DB.prepare("SELECT id FROM resource_packages WHERE kind='template' ORDER BY id").all<{ id: number }>()).results;
    if (!templates.length) throw new HttpError(400, "随机模板需要先上传至少一个 WEB 模板");
  } else if (templateId) {
    const template = await env.AIZZ_DB.prepare("SELECT id FROM resource_packages WHERE id=? AND kind='template'").bind(templateId).first<{ id: number }>();
    if (!template) throw new HttpError(400, "所选模板不存在");
    templates = [template];
  }
  const materials = (await env.AIZZ_DB.prepare(
    "SELECT id,domain FROM site_materials WHERE status='available' AND domain!='' ORDER BY id LIMIT ?",
  ).bind(count).all<{ id: number; domain: string }>()).results;
  if (materials.length < count) throw new HttpError(400, `可用且已绑定域名的网站材料只有 ${materials.length} 条，需要 ${count} 条`);
  const pluginIds = Array.isArray(body.plugin_ids) ? body.plugin_ids.map((id) => integer(id, "插件 ID")) : [];
  if (pluginIds.length) {
    const found = await env.AIZZ_DB.prepare(
      `SELECT COUNT(*) count FROM resource_packages WHERE kind='plugin' AND id IN (${pluginIds.map(() => "?").join(",")})`,
    ).bind(...pluginIds).first<{ count: number }>();
    if (Number(found?.count || 0) !== new Set(pluginIds).size) throw new HttpError(400, "所选 WEB 插件不存在");
  }
  const config = {
    simulate: body.simulate !== false,
    dns_target: text(body.dns_target, 300), dns_type: text(body.dns_type, 10) || "A",
    proxied: Boolean(body.proxied), php_version: text(body.php_version, 10) || "74",
    site_path_template: text(body.site_path_template, 500) || "/www/wwwroot/{domain}",
    rewrite_rule: String(body.rewrite_rule || "").slice(0, 100_000),
    required_files: Array.isArray(body.required_files) ? body.required_files.map((item) => text(item, 500)).filter(Boolean) : [],
    plugin_ids: [...new Set(pluginIds)], https: body.https !== false, keep_builds: Boolean(body.keep_builds),
    custom: body.custom && typeof body.custom === "object" && !Array.isArray(body.custom) ? body.custom : {},
  };
  if (!config.simulate && !body.bt_credential_id) throw new HttpError(400, "真实部署必须选择 BT API");
  if (body.cf_credential_id && !config.dns_target) throw new HttpError(400, "选择 Cloudflare API 后必须填写 DNS 解析目标");
  const timestamp = now();
  const batch = await env.AIZZ_DB.prepare(
    `INSERT INTO deployment_batches(name,status,source_id,template_id,random_template,database_id,
       bt_credential_id,cf_credential_id,config_json,domain_count,created_by,created_at,updated_at)
     VALUES(?,'ready',?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(text(body.name, 120) || `Edge 批次 ${timestamp.slice(0, 16)}`, sourceId, templateId,
    randomTemplate ? 1 : 0, body.database_id ? integer(body.database_id, "数据库") : null,
    body.bt_credential_id ? integer(body.bt_credential_id, "BT API") : null,
    body.cf_credential_id ? integer(body.cf_credential_id, "Cloudflare API") : null,
    JSON.stringify(config), count, user.id, timestamp, timestamp).run();
  const batchId = Number(batch.meta.last_row_id);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    const assignedTemplate = templates.length ? templates[(index + crypto.getRandomValues(new Uint8Array(1))[0]) % templates.length].id : null;
    statements.push(env.AIZZ_DB.prepare(
      `INSERT INTO deployments(batch_id,material_id,template_id,domain,status,created_at,updated_at)
       VALUES(?,?,?,?,'pending',?,?)`,
    ).bind(batchId, material.id, assignedTemplate, material.domain, timestamp, timestamp));
    statements.push(env.AIZZ_DB.prepare("UPDATE site_materials SET status='reserved',updated_at=? WHERE id=? AND status='available'")
      .bind(timestamp, material.id));
  }
  try {
    await env.AIZZ_DB.batch(statements);
  } catch (error) {
    await env.AIZZ_DB.prepare("DELETE FROM deployment_batches WHERE id=?").bind(batchId).run();
    throw error;
  }
  await audit(env, request, user, "deployment.create", "deployment_batch", String(batchId), { count, simulate: config.simulate });
  return json({ ok: true, id: batchId, count }, 201);
}

async function changePassword(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const currentPassword = String(body.current_password || "");
  const newPassword = String(body.new_password || "");
  const error = validatePassword(newPassword);
  if (error) throw new HttpError(400, error);
  const row = await env.AIZZ_DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(row.password_hash, currentPassword))) throw new HttpError(400, "当前密码错误");
  await env.AIZZ_DB.prepare("UPDATE users SET password_hash=?,force_password_change=0,updated_at=? WHERE id=?")
    .bind(await hashPassword(newPassword), now(), user.id).run();
  await audit(env, request, user, "user.password_changed", "user", String(user.id));
  return json({ ok: true });
}

async function createUser(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = await bodyJson(request);
  const username = text(body.username, 32);
  const password = String(body.password || "");
  const role = text(body.role, 20) as User["role"];
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, "用户名需为 3-32 位字母、数字、点、横线或下划线");
  const error = validatePassword(password);
  if (error) throw new HttpError(400, error);
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new HttpError(400, "用户角色无效");
  const timestamp = now();
  const result = await env.AIZZ_DB.prepare(
    `INSERT INTO users(username,password_hash,display_name,role,active,force_password_change,created_at,updated_at)
     VALUES(?,?,?,?,1,1,?,?)`,
  ).bind(username, await hashPassword(password), text(body.display_name, 100), role, timestamp, timestamp).run();
  await audit(env, request, user, "user.create", "user", String(result.meta.last_row_id), { username, role });
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function updateUser(request: Request, env: Env, user: SessionUser, id: number): Promise<Response> {
  const body = await bodyJson(request);
  const action = text(body.action, 20);
  const target = await env.AIZZ_DB.prepare("SELECT id,username,role,active FROM users WHERE id=?").bind(id).first<User>();
  if (!target) throw new HttpError(404, "用户不存在");
  if (action === "toggle") {
    if (id === user.id) throw new HttpError(400, "不能停用当前登录账号");
    if (target.role === "admin" && target.active) {
      const admins = await env.AIZZ_DB.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND active=1").first<{ count: number }>();
      if (Number(admins?.count || 0) <= 1) throw new HttpError(400, "不能停用最后一个有效管理员");
    }
    await env.AIZZ_DB.prepare("UPDATE users SET active=?,updated_at=? WHERE id=?").bind(target.active ? 0 : 1, now(), id).run();
  } else if (action === "reset_password") {
    const password = String(body.password || "");
    const error = validatePassword(password);
    if (error) throw new HttpError(400, error);
    await env.AIZZ_DB.batch([
      env.AIZZ_DB.prepare("UPDATE users SET password_hash=?,force_password_change=1,updated_at=? WHERE id=?")
        .bind(await hashPassword(password), now(), id),
      env.AIZZ_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
    ]);
  } else {
    throw new HttpError(400, "用户操作无效");
  }
  await audit(env, request, user, `user.${action}`, "user", String(id), { username: target.username });
  return json({ ok: true });
}

async function deleteEntity(request: Request, env: Env, user: SessionUser, type: string, id: number): Promise<Response> {
  if (type === "integration") {
    try { await env.AIZZ_DB.prepare("DELETE FROM api_credentials WHERE id=?").bind(id).run(); }
    catch { throw new HttpError(409, "该 API 配置正在被部署批次使用，不能删除"); }
    await audit(env, request, user, "integration.delete", "api_credential", String(id));
  } else if (type === "database") {
    try { await env.AIZZ_DB.prepare("DELETE FROM remote_databases WHERE id=?").bind(id).run(); }
    catch { throw new HttpError(409, "该数据库配置正在被部署批次使用，不能删除"); }
    await audit(env, request, user, "database.delete", "remote_database", String(id));
  } else if (type === "resource") {
    const row = await env.AIZZ_DB.prepare("SELECT object_key FROM resource_packages WHERE id=?").bind(id).first<{ object_key: string }>();
    if (!row) throw new HttpError(404, "资源不存在");
    try { await env.AIZZ_DB.prepare("DELETE FROM resource_packages WHERE id=?").bind(id).run(); }
    catch { throw new HttpError(409, "该资源正在被部署批次使用，不能删除"); }
    await env.AIZZ_STORAGE.delete(row.object_key);
    await audit(env, request, user, "resource.delete", "resource", String(id));
  } else {
    throw new HttpError(404, "删除目标不存在");
  }
  return json({ ok: true });
}

async function deleteBatch(request: Request, env: Env, user: SessionUser, id: number): Promise<Response> {
  const batch = await env.AIZZ_DB.prepare("SELECT status FROM deployment_batches WHERE id=?").bind(id).first<{ status: string }>();
  if (!batch) throw new HttpError(404, "部署批次不存在");
  if (batch.status === "success") throw new HttpError(409, "成功批次作为部署审计依据，不能删除");
  const materials = await env.AIZZ_DB.prepare("SELECT material_id FROM deployments WHERE batch_id=?").bind(id).all<{ material_id: number }>();
  const statements = materials.results.map((row) => env.AIZZ_DB.prepare(
    "UPDATE site_materials SET status='available',updated_at=? WHERE id=? AND status='reserved'",
  ).bind(now(), row.material_id));
  statements.push(env.AIZZ_DB.prepare("DELETE FROM deployment_batches WHERE id=?").bind(id));
  await env.AIZZ_DB.batch(statements);
  await audit(env, request, user, "deployment.delete", "deployment_batch", String(id));
  return json({ ok: true });
}

export async function handleRequest(request: Request, env: Env, _waitUntil?: WaitUntil): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (path === "/api/health" && request.method === "GET") {
      return json({ status: "ok", version: env.AIZZ_VERSION || "0.6.6", platform: "cloudflare-workers" });
    }
    const missingSecrets = [
      !env.SESSION_SECRET || env.SESSION_SECRET.length < 32 ? "SESSION_SECRET（至少 32 位）" : "",
      !env.MASTER_KEY || env.MASTER_KEY.length < 32 ? "MASTER_KEY（至少 32 位）" : "",
    ].filter(Boolean);
    if (missingSecrets.length) {
      throw new HttpError(
        503,
        `Worker Secret 未完整配置：${missingSecrets.join("、")}。请在 Worker Settings -> Variables and Secrets 中以 Secret 类型添加。`,
      );
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      const body = await bodyJson(request);
      const result = await login(request, env, text(body.username, 100), String(body.password || ""));
      return json({ ok: true, user: publicUser(result.user) }, 200, { "Set-Cookie": result.cookie });
    }
    await ensureInitialAdmin(env);
    const user = await requireUser(request, env);
    if (user.force_password_change && path !== "/api/auth/password" && path !== "/api/auth/logout" && path !== "/api/auth/me") {
      throw new HttpError(428, "首次登录必须修改初始密码");
    }

    if (path === "/api/auth/me" && request.method === "GET") return json({ user: publicUser(user), version: env.AIZZ_VERSION || "0.6.6" });
    if (path === "/api/auth/logout" && request.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": await logout(request, env, user) });
    if (path === "/api/auth/password" && request.method === "POST") return changePassword(request, env, user);
    if (path === "/api/dashboard" && request.method === "GET") return dashboard(env);

    if (path === "/api/integrations" && request.method === "GET") {
      const rows = await env.AIZZ_DB.prepare(
        "SELECT id,kind,name,base_url,extra_json,enabled,last_test_status,last_test_message,last_test_at,created_at FROM api_credentials ORDER BY kind,id",
      ).all();
      return json({ rows: rows.results });
    }
    if (path === "/api/integrations" && request.method === "POST") {
      await requireUser(request, env, ['admin']);
      return saveIntegration(request, env, user);
    }
    let id = routeId(path, /^\/api\/integrations\/(\d+)\/test$/);
    if (id && request.method === "POST") return testIntegration(request, env, user, id);
    id = routeId(path, /^\/api\/integrations\/(\d+)\/environment$/);
    if (id && request.method === "POST") return testIntegration(request, env, user, id, true);
    id = routeId(path, /^\/api\/integrations\/(\d+)$/);
    if (id && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      return deleteEntity(request, env, user, "integration", id);
    }

    if (path === "/api/databases" && request.method === "GET") {
      const rows = await env.AIZZ_DB.prepare("SELECT id,name,db_type,host,port,database_name,username,created_at FROM remote_databases ORDER BY id").all();
      return json({ rows: rows.results });
    }
    if (path === "/api/databases" && request.method === "POST") return saveDatabase(request, env, user);
    id = routeId(path, /^\/api\/databases\/(\d+)$/);
    if (id && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      return deleteEntity(request, env, user, "database", id);
    }

    if (path === "/api/resources" && request.method === "GET") {
      const kind = url.searchParams.get("kind") || "";
      const query = kind
        ? env.AIZZ_DB.prepare("SELECT * FROM resource_packages WHERE kind=? ORDER BY id DESC").bind(kind)
        : env.AIZZ_DB.prepare("SELECT * FROM resource_packages ORDER BY id DESC");
      return json({ rows: (await query.all()).results });
    }
    if (path === "/api/resources" && request.method === "POST") return uploadResource(request, env, user);
    id = routeId(path, /^\/api\/resources\/(\d+)\/mappings$/);
    if (id && request.method === "PUT") {
      const body = await bodyJson(request);
      const mappings = validateMappings(JSON.stringify(body.mappings || []));
      await env.AIZZ_DB.prepare("UPDATE resource_packages SET mapping_json=?,updated_at=? WHERE id=?")
        .bind(JSON.stringify(mappings), now(), id).run();
      await audit(env, request, user, "resource.mappings_update", "resource", String(id), { count: mappings.length });
      return json({ ok: true });
    }
    id = routeId(path, /^\/api\/resources\/(\d+)$/);
    if (id && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      return deleteEntity(request, env, user, "resource", id);
    }

    if (path === "/api/materials" && request.method === "GET") {
      const rows = await env.AIZZ_DB.prepare("SELECT * FROM site_materials ORDER BY id DESC LIMIT 200").all();
      return json({ rows: rows.results });
    }
    if (path === "/api/materials/import" && request.method === "POST") return importMaterials(request, env, user);
    if (path === "/api/materials/generate" && request.method === "POST") return generateMaterials(request, env, user);
    id = routeId(path, /^\/api\/materials\/(\d+)$/);
    if (id && request.method === "PUT") return updateMaterial(request, env, user, id);
    if (id && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      try {
        const result = await env.AIZZ_DB.prepare("DELETE FROM site_materials WHERE id=? AND status IN ('available','disabled')").bind(id).run();
        if (!result.meta.changes) throw new HttpError(409, "已占用或已使用的材料不能删除");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, "该材料正在被部署批次使用，不能删除");
      }
      await audit(env, request, user, "material.delete", "site_material", String(id));
      return json({ ok: true });
    }

    if (path === "/api/deployments" && request.method === "GET") {
      const rows = await env.AIZZ_DB.prepare("SELECT * FROM deployment_batches ORDER BY id DESC LIMIT 100").all();
      return json({ rows: rows.results });
    }
    if (path === "/api/deployments" && request.method === "POST") return createBatch(request, env, user);
    id = routeId(path, /^\/api\/deployments\/(\d+)$/);
    if (id && request.method === "GET") {
      const batch = await env.AIZZ_DB.prepare("SELECT * FROM deployment_batches WHERE id=?").bind(id).first();
      if (!batch) throw new HttpError(404, "部署批次不存在");
      const sites = await env.AIZZ_DB.prepare("SELECT * FROM deployments WHERE batch_id=? ORDER BY id").bind(id).all();
      return json({ batch, sites: sites.results });
    }
    if (id && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      return deleteBatch(request, env, user, id);
    }
    id = routeId(path, /^\/api\/deployments\/(\d+)\/run-next$/);
    if (id && request.method === "POST") return json(await processNextDeployment(env, id));
    id = routeId(path, /^\/api\/deployments\/(\d+)\/retry$/);
    if (id && request.method === "POST") {
      await env.AIZZ_DB.prepare("UPDATE deployments SET status='pending',error_message='',finished_at=NULL,updated_at=? WHERE batch_id=? AND status='failed'")
        .bind(now(), id).run();
      await env.AIZZ_DB.prepare("UPDATE deployment_batches SET status='ready',finished_at=NULL,updated_at=? WHERE id=?").bind(now(), id).run();
      await audit(env, request, user, "deployment.retry", "deployment_batch", String(id));
      return json({ ok: true });
    }

    if (path === "/api/logs" && request.method === "GET") {
      const batchId = Number(url.searchParams.get("batch_id") || 0);
      const query = batchId
        ? env.AIZZ_DB.prepare("SELECT * FROM task_logs WHERE batch_id=? ORDER BY id DESC LIMIT 500").bind(batchId)
        : env.AIZZ_DB.prepare("SELECT * FROM task_logs ORDER BY id DESC LIMIT 500");
      return json({ rows: (await query.all()).results });
    }
    if (path === "/api/audit" && request.method === "GET") {
      await requireUser(request, env, ['admin']);
      return json({ rows: (await env.AIZZ_DB.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500").all()).results });
    }
    if (path === "/api/audit" && request.method === "DELETE") {
      await requireUser(request, env, ['admin']);
      const body = await bodyJson(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map((value) => integer(value, "审计 ID")))].slice(0, 500) : [];
      if (!ids.length) throw new HttpError(400, "请选择要删除的审计记录");
      await env.AIZZ_DB.prepare(`DELETE FROM audit_logs WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
      await audit(env, request, user, "audit.bulk_delete", "audit_log", "bulk", { count: ids.length });
      return json({ ok: true, deleted: ids.length });
    }

    if (path === "/api/users" && request.method === "GET") {
      await requireUser(request, env, ['admin']);
      const rows = await env.AIZZ_DB.prepare(
        "SELECT id,username,display_name,role,active,force_password_change,last_login_at,created_at FROM users ORDER BY id",
      ).all();
      return json({ rows: rows.results });
    }
    if (path === "/api/users" && request.method === "POST") {
      await requireUser(request, env, ['admin']);
      return createUser(request, env, user);
    }
    id = routeId(path, /^\/api\/users\/(\d+)$/);
    if (id && request.method === "POST") {
      await requireUser(request, env, ['admin']);
      return updateUser(request, env, user, id);
    }
    throw new HttpError(404, "API 路径不存在");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, details: error.details }, error.status);
    const requestId = crypto.randomUUID();
    console.error("AIZZ Edge request failed", requestId, error);
    if (path === "/api/auth/login") {
      return json({
        error: "初始化登录失败",
        details: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        request_id: requestId,
      }, 500);
    }
    return json({ error: "服务器内部错误", request_id: requestId }, 500);
  }
}

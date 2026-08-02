import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { parseJson } from "../http";
import type { Env, ResourceMapping } from "../types";

const MAX_FILES = 5_000;
const MAX_UNCOMPRESSED = 48 * 1024 * 1024;
const MAX_TEXT_FILE = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "json", "xml", "txt", "md", "php", "py", "ini",
  "conf", "config", "env", "yml", "yaml", "sql", "tpl", "vue", "ts", "tsx", "jsx",
]);

interface ResourceRow {
  id: number;
  name: string;
  kind: string;
  object_key: string;
  mapping_json: string;
}

export interface SiteMaterial {
  id: number;
  keyword: string;
  domain: string;
  site_name: string;
  title: string;
  description: string;
}

interface DatabaseRow {
  name?: string;
  db_type?: string;
  host?: string;
  port?: number | null;
  database_name?: string;
  username?: string;
  password?: string;
}

export interface BuildConfig {
  https?: boolean;
  custom?: Record<string, string>;
  plugin_ids?: number[];
  required_files?: string[];
  keep_builds?: boolean;
}

export interface BuiltSite {
  bytes: Uint8Array;
  filename: string;
  tokens: Record<string, string>;
  changedFiles: string[];
}

function normalizeArchive(files: Unzipped): Unzipped {
  const normalized: Unzipped = {};
  const names = Object.keys(files).filter((name) => !name.endsWith("/") && !name.includes("__MACOSX/"));
  if (!names.length) throw new Error("ZIP 压缩包为空");
  if (names.length > MAX_FILES) throw new Error(`ZIP 文件数量超过免费版限制 ${MAX_FILES}`);
  const parts = names.map((name) => name.replaceAll("\\", "/").split("/").filter(Boolean));
  const commonRoot = parts.every((item) => item.length > 1 && item[0] === parts[0][0]) ? `${parts[0][0]}/` : "";
  let total = 0;
  for (const original of names) {
    const safe = original.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!safe || safe.startsWith("/") || safe.includes("../") || /^[A-Za-z]:/.test(safe)) {
      throw new Error(`ZIP 包含非法路径：${original}`);
    }
    const name = commonRoot && safe.startsWith(commonRoot) ? safe.slice(commonRoot.length) : safe;
    if (!name) continue;
    total += files[original].length;
    if (total > MAX_UNCOMPRESSED) throw new Error("ZIP 解压后超过 Edge 免费版 48MB 限制");
    normalized[name] = files[original];
  }
  return normalized;
}

async function readArchive(env: Env, resource: ResourceRow): Promise<Unzipped> {
  const object = await env.AIZZ_STORAGE.get(resource.object_key);
  if (!object) throw new Error(`R2 中缺少资源：${resource.name}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    return normalizeArchive(unzipSync(bytes));
  } catch (error) {
    throw new Error(`资源“${resource.name}”解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function randomString(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function sourceValue(source: string, tokens: Record<string, string>, custom: Record<string, string>): string {
  const aliases: Record<string, string> = {
    domain: "AIZZ_DOMAIN", site_name: "AIZZ_SITE_NAME", site_url: "AIZZ_SITE_URL",
    keyword: "AIZZ_KEYWORD", title: "AIZZ_TITLE", description: "AIZZ_DESCRIPTION",
    template_name: "AIZZ_TEMPLATE_NAME", db_type: "AIZZ_DB_TYPE", db_host: "AIZZ_DB_HOST",
    db_port: "AIZZ_DB_PORT", db_name: "AIZZ_DB_NAME", db_user: "AIZZ_DB_USER",
    db_password: "AIZZ_DB_PASSWORD",
  };
  if (source === "random_chars_13") return randomString(13, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789");
  if (source === "random_letters_6_8") return randomString(6 + crypto.getRandomValues(new Uint8Array(1))[0] % 3, "abcdefghijklmnopqrstuvwxyz");
  if (source === "tracking_code") return String(custom.tracking_code || custom.AIZZ_TRACKING_CODE || "");
  const token = aliases[source] || source.toUpperCase();
  return tokens[token] ?? String(custom[source] ?? custom[token] ?? "");
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT_FILE || bytes.includes(0)) return null;
  try {
    return strFromU8(bytes, false);
  } catch {
    return null;
  }
}

function isTextPath(path: string): boolean {
  const extension = path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension) || /(^|\/)\.env(?:\.|$)/.test(path);
}

function replaceAllLiteral(source: string, marker: string, value: string): string {
  return marker ? source.split(marker).join(value) : source;
}

function applyMappings(
  files: Unzipped, resources: ResourceRow[], tokens: Record<string, string>, custom: Record<string, string>,
): string[] {
  const changed = new Set<string>();
  const mappings = resources.flatMap((resource) => parseJson<ResourceMapping[]>(resource.mapping_json, []));
  for (const [path, bytes] of Object.entries(files)) {
    if (!isTextPath(path)) continue;
    const original = decodeText(bytes);
    if (original === null) continue;
    let content = original;
    for (const [name, value] of Object.entries(tokens)) {
      content = replaceAllLiteral(content, `{{${name}}}`, value);
      content = replaceAllLiteral(content, `\${${name}}`, value);
    }
    for (const mapping of mappings) {
      const target = String(mapping.path || "").replaceAll("\\", "/").replace(/^\.\//, "");
      if (target && target !== path) continue;
      let value = sourceValue(String(mapping.source || "custom"), tokens, custom);
      if (!value) value = String(mapping.default_value || "");
      if (mapping.required && !value) throw new Error(`${path} 的必填绑定“${mapping.marker}”没有值`);
      content = replaceAllLiteral(content, String(mapping.marker || ""), value);
    }
    if (content !== original) {
      files[path] = strToU8(content);
      changed.add(path);
    }
  }
  return [...changed].sort();
}

function validateFiles(files: Unzipped, required: string[]): void {
  const entries = ["index.php", "index.html", "index.htm"];
  if (!entries.some((name) => files[name])) throw new Error("合成包根目录缺少 index.php/index.html/index.htm");
  for (const raw of required) {
    const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!path || path.includes("../") || !files[path]) throw new Error(`合成包缺少必需文件：${raw}`);
  }
}

export async function buildSite(
  env: Env,
  resources: ResourceRow[],
  material: SiteMaterial,
  database: DatabaseRow,
  config: BuildConfig,
): Promise<BuiltSite> {
  if (!resources.length || resources[0].kind !== "source") throw new Error("部署批次缺少内核源码");
  const files: Unzipped = {};
  for (const resource of resources) Object.assign(files, await readArchive(env, resource));
  const custom = config.custom || {};
  const template = resources.find((item) => item.kind === "template");
  const tokens: Record<string, string> = {
    AIZZ_DOMAIN: material.domain,
    AIZZ_SITE_NAME: material.site_name || material.keyword || material.domain,
    AIZZ_SITE_URL: `${config.https === false ? "http" : "https"}://${material.domain}`,
    AIZZ_KEYWORD: material.keyword,
    AIZZ_TITLE: material.title,
    AIZZ_DESCRIPTION: material.description,
    AIZZ_TEMPLATE_NAME: template?.name || "",
    AIZZ_DB_TYPE: database.db_type || "",
    AIZZ_DB_HOST: database.host || "",
    AIZZ_DB_PORT: database.port ? String(database.port) : "",
    AIZZ_DB_NAME: database.database_name || "",
    AIZZ_DB_USER: database.username || "",
    AIZZ_DB_PASSWORD: database.password || "",
  };
  for (const [key, value] of Object.entries(custom)) tokens[key.toUpperCase()] ??= String(value);
  const changedFiles = applyMappings(files, resources, tokens, custom);
  validateFiles(files, config.required_files || []);
  files[".aizz-deployment.json"] = strToU8(JSON.stringify({
    generated_by: "AIZZ Cloudflare Edge",
    domain: material.domain,
    site_name: tokens.AIZZ_SITE_NAME,
    template: tokens.AIZZ_TEMPLATE_NAME,
    configured_files: changedFiles,
    generated_at: new Date().toISOString(),
  }, null, 2));
  // Store mode minimizes Worker CPU usage. BT performs the final extraction,
  // so stronger compression is a poor tradeoff on the free Workers tier.
  const bytes = zipSync(files, { level: 0 });
  if (bytes.length > 50 * 1024 * 1024) throw new Error("合成 ZIP 超过 Edge 版 50MB 限制");
  const slug = material.domain.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return { bytes, filename: `aizz-${slug}.zip`, tokens, changedFiles };
}

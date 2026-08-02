import { createHash } from "node:crypto";
import { decryptSecret } from "../crypto";
import { HttpError, parseJson } from "../http";
import type { ApiCredential, Env } from "../types";

interface BtExtra {
  access_client_id?: string;
  access_client_secret?: string;
}

interface CfExtra {
  account_id?: string;
}

function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function messageFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return String(record.msg || record.message || record.error || "API 操作失败");
  }
  return "API 操作失败";
}

export class BtClient {
  private readonly baseUrl: string;
  private readonly extra: BtExtra;

  constructor(baseUrl: string, private readonly apiKey: string, extraJson = "{}") {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new HttpError(400, "BT 面板地址无效");
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, "BT 面板只支持 HTTP/HTTPS 地址");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.extra = parseJson<BtExtra>(extraJson, {});
  }

  private auth(): Record<string, string> {
    const requestTime = String(Math.floor(Date.now() / 1000));
    return {
      request_time: requestTime,
      request_token: md5(requestTime + md5(this.apiKey)),
    };
  }

  private headers(): Headers {
    const headers = new Headers();
    if (this.extra.access_client_id) headers.set("CF-Access-Client-Id", this.extra.access_client_id);
    if (this.extra.access_client_secret) headers.set("CF-Access-Client-Secret", this.extra.access_client_secret);
    return headers;
  }

  async request(endpoint: string, data: Record<string, string> = {}): Promise<unknown> {
    const body = new URLSearchParams({ ...this.auth(), ...data });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${endpoint.replace(/^\//, "")}`, {
        method: "POST", headers: this.headers(), body,
      });
    } catch (error) {
      throw new Error(`BT 请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await response.text();
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error(`BT 返回非 JSON 内容（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(`BT HTTP ${response.status}：${messageFrom(result)}`);
    if (result && typeof result === "object" && (result as Record<string, unknown>).status === false) {
      throw new Error(messageFrom(result));
    }
    return result;
  }

  async test(): Promise<Record<string, unknown>> {
    const system = await this.request("system?action=GetSystemTotal");
    return { message: "BT 面板连接成功", system };
  }

  async environment(): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    let system: unknown = {};
    let versions: unknown = [];
    let rewrites: unknown = [];
    try { system = await this.request("system?action=GetSystemTotal"); } catch (error) { warnings.push(messageFrom(error)); }
    try { versions = await this.request("site?action=GetPHPVersion"); } catch (error) { warnings.push(messageFrom(error)); }
    try {
      rewrites = await this.request("files?action=GetDir", { path: "/www/server/panel/rewrite/nginx" });
    } catch (error) { warnings.push(messageFrom(error)); }
    return { system, php_versions: versions, rewrite_templates: rewrites, warnings };
  }

  async findSite(domain: string): Promise<Record<string, unknown> | null> {
    const result = await this.request("data?action=getData", {
      table: "sites", limit: "100", p: "1", search: domain,
    });
    const rows = Array.isArray(result) ? result : (result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).data)
      ? (result as { data: unknown[] }).data : []);
    return (rows.find((row) => row && typeof row === "object" &&
      String((row as Record<string, unknown>).name || "").toLowerCase() === domain.toLowerCase()) as Record<string, unknown>) || null;
  }

  async ensureSite(domain: string, path: string, phpVersion: string): Promise<Record<string, unknown>> {
    const existing = await this.findSite(domain).catch(() => null);
    if (existing) return { ...existing, existing: true };
    const webname = JSON.stringify({ domain, domainlist: [], count: 0 });
    const result = await this.request("site?action=AddSite", {
      webname, path, type_id: "0", type: "PHP", version: phpVersion,
      port: "80", ps: `AIZZ:${domain}`, ftp: "false", sql: "false",
      codeing: "utf8mb4", set_ssl: "0",
    });
    return result && typeof result === "object" ? result as Record<string, unknown> : { result };
  }

  async deleteFile(path: string): Promise<void> {
    await this.request("files?action=DeleteFile", { path });
  }

  async uploadArchive(remoteDirectory: string, filename: string, bytes: Uint8Array): Promise<void> {
    const chunkSize = 1024 * 1024;
    let endpoint = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
      const candidates = endpoint ? [endpoint] : ["files?action=UploadFile", "files?action=upload"];
      let uploaded = false;
      let lastError = "";
      for (const candidate of candidates) {
        const form = new FormData();
        for (const [key, value] of Object.entries(this.auth())) form.set(key, value);
        form.set("f_path", remoteDirectory);
        form.set("f_name", filename);
        form.set("f_size", String(bytes.length));
        form.set("f_start", String(offset));
        const chunkBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
        form.set("blob", new Blob([chunkBuffer], { type: "application/octet-stream" }), filename);
        try {
          const response = await fetch(`${this.baseUrl}/${candidate}`, { method: "POST", headers: this.headers(), body: form });
          const raw = await response.text();
          let result: unknown = raw;
          try { result = JSON.parse(raw); } catch { /* handled below */ }
          if (!response.ok) {
            lastError = `HTTP ${response.status} ${messageFrom(result)}`;
            if (!endpoint && response.status === 404) continue;
            throw new Error(lastError);
          }
          if (result && typeof result === "object" && (result as Record<string, unknown>).status === false) {
            throw new Error(messageFrom(result));
          }
          endpoint = candidate;
          uploaded = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (endpoint) throw error;
        }
      }
      if (!uploaded) throw new Error(`BT 文件上传失败（偏移 ${offset}）：${lastError}`);
    }
  }

  async unzip(remoteArchive: string, destination: string): Promise<void> {
    await this.request("files?action=UnZip", {
      sfile: remoteArchive, dfile: destination, type: "zip", coding: "UTF-8", password: "",
    });
  }

  async setRewrite(domain: string, content: string): Promise<void> {
    const path = `/www/server/panel/vhost/rewrite/${domain}.conf`;
    try {
      await this.request("files?action=SaveFileBody", { path, data: content, encoding: "utf-8" });
    } catch {
      await this.request("site?action=SetSiteRewrite", { siteName: domain, rewrite: content });
    }
    const actual = await this.request("files?action=GetFileBody", { path });
    const text = typeof actual === "string" ? actual : String((actual as Record<string, unknown>)?.data || "");
    if (text.trim() !== content.trim()) throw new Error("BT 伪静态规则写入后回读不一致");
  }

  async disableAccessLog(siteId: string, domain: string): Promise<void> {
    const result = await this.request("files?action=GetFileBody", {
      path: `/www/server/panel/vhost/nginx/${domain}.conf`,
    });
    const content = typeof result === "string" ? result : String((result as Record<string, unknown>)?.data || "");
    const enabled = /^\s*access_log\s+(?!off\s*;|\/dev\/null\s*;)[^;]+;/im.test(content);
    if (!enabled) return;
    try {
      await this.request("site?action=logsOpen", { id: siteId });
    } catch {
      await this.request("site?action=SetSiteLogs", { id: siteId });
    }
  }
}

export class CloudflareClient {
  private readonly headers: Headers;
  private readonly extra: CfExtra;

  constructor(private readonly token: string, extraJson = "{}") {
    this.headers = new Headers({ Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}`, "Content-Type": "application/json" });
    this.extra = parseJson<CfExtra>(extraJson, {});
  }

  private async request(method: string, endpoint: string, payload?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint.replace(/^\//, "")}`, {
      method, headers: this.headers, body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const data = await response.json() as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
    if (!response.ok || data.success !== true) {
      const message = data.errors?.map((item) => item.message || JSON.stringify(item)).join("; ");
      throw new Error(message || `Cloudflare API HTTP ${response.status}`);
    }
    return data.result;
  }

  async test(): Promise<Record<string, unknown>> {
    const result = await this.request("GET", "user/tokens/verify");
    return { message: "Cloudflare API Token 有效", result };
  }

  async findZone(domain: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ status: "active", per_page: "50" });
    if (this.extra.account_id) query.set("account.id", this.extra.account_id);
    const result = await this.request("GET", `zones?${query}`);
    const zones = Array.isArray(result) ? result as Record<string, unknown>[] : [];
    const normalized = domain.toLowerCase().replace(/\.$/, "");
    const matches = zones.filter((zone) => {
      const name = String(zone.name || "").toLowerCase();
      return normalized === name || normalized.endsWith(`.${name}`);
    }).sort((left, right) => String(right.name).length - String(left.name).length);
    if (!matches.length) throw new Error(`Cloudflare 未找到 ${domain} 对应的已激活区域`);
    return matches[0];
  }

  async upsertDns(domain: string, type: string, content: string, proxied: boolean): Promise<Record<string, unknown>> {
    const zone = await this.findZone(domain);
    const zoneId = String(zone.id);
    const query = new URLSearchParams({ type, name: domain, per_page: "1" });
    const records = await this.request("GET", `zones/${zoneId}/dns_records?${query}`);
    const existing = Array.isArray(records) ? records[0] as Record<string, unknown> | undefined : undefined;
    const payload = { type, name: domain, content, proxied, ttl: 1 };
    const record = await this.request(existing ? "PUT" : "POST",
      existing ? `zones/${zoneId}/dns_records/${existing.id}` : `zones/${zoneId}/dns_records`, payload) as Record<string, unknown>;
    const verified = await this.request("GET", `zones/${zoneId}/dns_records/${record.id}`) as Record<string, unknown>;
    if (String(verified.type).toUpperCase() !== type.toUpperCase() ||
        String(verified.name).toLowerCase() !== domain.toLowerCase() ||
        String(verified.content).toLowerCase() !== content.toLowerCase()) {
      throw new Error("Cloudflare DNS 写入后回读校验不一致");
    }
    return { ...verified, zone_id: zoneId };
  }
}

export async function credentialClient(env: Env, credential: ApiCredential): Promise<BtClient | CloudflareClient> {
  const secret = await decryptSecret(credential.secret_data, env.MASTER_KEY);
  if (credential.kind === "bt") {
    const payload = parseJson<{ api_key?: string; access_client_secret?: string }>(secret, {});
    const apiKey = payload.api_key || secret;
    const extra = parseJson<BtExtra>(credential.extra_json, {});
    if (payload.access_client_secret) extra.access_client_secret = payload.access_client_secret;
    return new BtClient(credential.base_url, apiKey, JSON.stringify(extra));
  }
  return new CloudflareClient(secret, credential.extra_json);
}

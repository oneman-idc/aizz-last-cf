import { decryptSecret } from "../crypto";
import { now, parseJson } from "../http";
import type { ApiCredential, Env } from "../types";
import { buildSite, type BuildConfig, type SiteMaterial } from "./build";
import { BtClient, CloudflareClient, credentialClient } from "./integrations";

interface DeploymentRow extends SiteMaterial {
  deployment_id: number;
  batch_id: number;
  source_id: number;
  template_id: number | null;
  database_id: number | null;
  bt_credential_id: number | null;
  cf_credential_id: number | null;
  config_json: string;
}

interface DeploymentConfig extends BuildConfig {
  simulate?: boolean;
  dns_target?: string;
  dns_type?: string;
  proxied?: boolean;
  php_version?: string;
  site_path_template?: string;
  rewrite_rule?: string;
}

async function log(
  env: Env, batchId: number, deploymentId: number | null, channel: string, level: string,
  message: string, context: unknown = {},
): Promise<void> {
  await env.AIZZ_DB.prepare(
    "INSERT INTO task_logs(batch_id,deployment_id,channel,level,message,context_json,created_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(batchId, deploymentId, channel, level, message, JSON.stringify(context), now()).run();
}

async function loadCredential(env: Env, id: number | null): Promise<ApiCredential | null> {
  if (!id) return null;
  return await env.AIZZ_DB.prepare(
    "SELECT id,kind,name,base_url,secret_data,extra_json,enabled FROM api_credentials WHERE id=? AND enabled=1",
  ).bind(id).first<ApiCredential>();
}

async function refreshBatch(env: Env, batchId: number): Promise<void> {
  const counts = await env.AIZZ_DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success_count,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_count,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending_count
       FROM deployments WHERE batch_id=?`,
  ).bind(batchId).first<{ total: number; success_count: number; failed_count: number; pending_count: number }>();
  if (!counts) return;
  const finished = Number(counts.pending_count) === 0;
  const status = !finished ? "running" : Number(counts.failed_count) === 0 ? "success" :
    Number(counts.success_count) === 0 ? "failed" : "partial";
  await env.AIZZ_DB.prepare(
    "UPDATE deployment_batches SET status=?,success_count=?,failed_count=?,updated_at=?,finished_at=? WHERE id=?",
  ).bind(status, counts.success_count || 0, counts.failed_count || 0, now(), finished ? now() : null, batchId).run();
}

function sitePath(template: string, domain: string): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const value = (template || "/www/wwwroot/{domain}").replaceAll("{domain}", domain).replaceAll("{site_slug}", slug);
  if (!value.startsWith("/") || value.includes("..")) throw new Error("BT 站点目录模板无效");
  return value.replace(/\/$/, "");
}

export async function processNextDeployment(env: Env, batchId: number): Promise<Record<string, unknown>> {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await env.AIZZ_DB.prepare(
    `UPDATE deployments SET status='pending',error_message='上次 Worker 请求中断，已自动恢复',updated_at=?
      WHERE batch_id=? AND status IN ('building','uploading','creating_site','creating_dns') AND updated_at<?`,
  ).bind(now(), batchId, staleBefore).run();
  const deployment = await env.AIZZ_DB.prepare(
    `SELECT d.id deployment_id,d.batch_id,d.template_id,d.domain,
            m.id,m.keyword,m.site_name,m.title,m.description,
            b.source_id,b.database_id,b.bt_credential_id,b.cf_credential_id,b.config_json
       FROM deployments d
       JOIN deployment_batches b ON b.id=d.batch_id
       JOIN site_materials m ON m.id=d.material_id
      WHERE d.batch_id=? AND d.status='pending'
      ORDER BY d.id LIMIT 1`,
  ).bind(batchId).first<DeploymentRow>();
  if (!deployment) {
    await refreshBatch(env, batchId);
    return { done: true, batch_id: batchId };
  }
  const config = parseJson<DeploymentConfig>(deployment.config_json, {});
  const simulate = config.simulate !== false;
  const timestamp = now();
  const claim = await env.AIZZ_DB.prepare(
    "UPDATE deployments SET status='building',error_message='',started_at=?,updated_at=? WHERE id=? AND status='pending'",
  ).bind(timestamp, timestamp, deployment.deployment_id).run();
  if (!claim.meta.changes) return { done: false, batch_id: batchId, busy: true };
  await env.AIZZ_DB.prepare(
    "UPDATE deployment_batches SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?",
  ).bind(timestamp, timestamp, batchId).run();
  await log(env, batchId, deployment.deployment_id, "build", "info", `开始合成 ${deployment.domain}`);
  let buildKey = "";
  try {
    const pluginIds = (config.plugin_ids || []).filter((id) => Number.isSafeInteger(id) && id > 0);
    const resourceIds = [deployment.source_id, deployment.template_id, ...pluginIds].filter(Boolean) as number[];
    const placeholders = resourceIds.map(() => "?").join(",");
    const result = await env.AIZZ_DB.prepare(
      `SELECT id,name,kind,object_key,mapping_json FROM resource_packages WHERE id IN (${placeholders})`,
    ).bind(...resourceIds).all<Record<string, unknown>>();
    const byId = new Map(result.results.map((row) => [Number(row.id), row]));
    const ordered = resourceIds.map((id) => byId.get(id)).filter(Boolean) as Array<{
      id: number; name: string; kind: string; object_key: string; mapping_json: string;
    }>;
    if (ordered.length !== resourceIds.length) throw new Error("部署引用的源码、模板或插件已不存在");

    let database: Record<string, unknown> = {};
    if (deployment.database_id) {
      database = await env.AIZZ_DB.prepare("SELECT * FROM remote_databases WHERE id=?")
        .bind(deployment.database_id).first<Record<string, unknown>>() || {};
      if (database.secret_data) database.password = await decryptSecret(String(database.secret_data), env.MASTER_KEY);
    }
    const built = await buildSite(env, ordered, deployment, database, config);
    buildKey = `builds/batch-${batchId}/${deployment.domain}/${built.filename}`;
    await env.AIZZ_STORAGE.put(buildKey, built.bytes, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: { domain: deployment.domain, batch: String(batchId) },
    });
    await env.AIZZ_DB.prepare(
      "UPDATE deployments SET build_object_key=?,site_path=?,updated_at=? WHERE id=?",
    ).bind(buildKey, sitePath(config.site_path_template || "", deployment.domain), now(), deployment.deployment_id).run();
    await log(env, batchId, deployment.deployment_id, "build", "info", "源码完整性和字段绑定校验通过", {
      archive_bytes: built.bytes.length, changed_files: built.changedFiles,
    });

    let btResult: Record<string, unknown> = { simulated: true };
    let dnsResult: Record<string, unknown> = { simulated: true };
    let targetPath = sitePath(config.site_path_template || "", deployment.domain);
    if (!simulate) {
      const btCredential = await loadCredential(env, deployment.bt_credential_id);
      if (!btCredential || btCredential.kind !== "bt") throw new Error("真实部署需要可用的 BT API 配置");
      const bt = await credentialClient(env, btCredential);
      if (!(bt instanceof BtClient)) throw new Error("BT API 配置类型错误");
      await env.AIZZ_DB.prepare("UPDATE deployments SET status='creating_site',updated_at=? WHERE id=?")
        .bind(now(), deployment.deployment_id).run();
      btResult = await bt.ensureSite(deployment.domain, targetPath, config.php_version || "74");
      const siteId = String(btResult.siteId || btResult.id || "");
      if (btResult.existing && btResult.path) {
        const existingPath = String(btResult.path);
        if (!existingPath.startsWith("/") || existingPath.includes("..")) throw new Error("BT 已有站点返回了非法网站目录");
        targetPath = existingPath.replace(/\/$/, "");
        await env.AIZZ_DB.prepare("UPDATE deployments SET site_path=?,updated_at=? WHERE id=?")
          .bind(targetPath, now(), deployment.deployment_id).run();
      }
      await log(env, batchId, deployment.deployment_id, "bt", "info", btResult.existing ? "复用已有 BT 站点" : "BT 站点创建成功");
      for (const filename of ["404.html", "502.html", "index.html"]) {
        await bt.deleteFile(`${targetPath}/${filename}`).catch(() => undefined);
      }
      await env.AIZZ_DB.prepare("UPDATE deployments SET status='uploading',bt_site_id=?,updated_at=? WHERE id=?")
        .bind(siteId, now(), deployment.deployment_id).run();
      await bt.uploadArchive("/tmp", built.filename, built.bytes);
      await bt.unzip(`/tmp/${built.filename}`, targetPath);
      await bt.deleteFile(`/tmp/${built.filename}`).catch(() => undefined);
      if (siteId) await bt.disableAccessLog(siteId, deployment.domain).catch(async (error) => {
        await log(env, batchId, deployment.deployment_id, "bt", "warning", `关闭访问日志失败：${String(error)}`);
      });
      if (config.rewrite_rule) await bt.setRewrite(deployment.domain, config.rewrite_rule);
      await log(env, batchId, deployment.deployment_id, "bt", "info", "源码上传、解压和站点配置完成");

      if (deployment.cf_credential_id) {
        if (!config.dns_target) throw new Error("已选择 Cloudflare API，但没有填写 DNS 解析目标");
        const cfCredential = await loadCredential(env, deployment.cf_credential_id);
        if (!cfCredential || cfCredential.kind !== "cloudflare") throw new Error("Cloudflare API 配置不可用");
        const cf = await credentialClient(env, cfCredential);
        if (!(cf instanceof CloudflareClient)) throw new Error("Cloudflare API 配置类型错误");
        await env.AIZZ_DB.prepare("UPDATE deployments SET status='creating_dns',updated_at=? WHERE id=?")
          .bind(now(), deployment.deployment_id).run();
        dnsResult = await cf.upsertDns(deployment.domain, config.dns_type || "A", config.dns_target, Boolean(config.proxied));
        await env.AIZZ_DB.prepare(
          "UPDATE deployments SET cf_zone_id=?,cf_record_id=?,updated_at=? WHERE id=?",
        ).bind(String(dnsResult.zone_id || ""), String(dnsResult.id || ""), now(), deployment.deployment_id).run();
        await log(env, batchId, deployment.deployment_id, "cloudflare", "info", "Cloudflare DNS 已创建并回读验证");
      }
    } else {
      await log(env, batchId, deployment.deployment_id, "system", "warning", "模拟执行：未调用 BT 和 Cloudflare API");
    }

    await env.AIZZ_DB.batch([
      env.AIZZ_DB.prepare(
        "UPDATE deployments SET status='success',result_json=?,finished_at=?,updated_at=? WHERE id=?",
      ).bind(JSON.stringify({ bt: btResult, cloudflare: dnsResult, build: buildKey }), now(), now(), deployment.deployment_id),
      env.AIZZ_DB.prepare("UPDATE site_materials SET status=?,updated_at=? WHERE id=?")
        .bind(simulate ? "available" : "used", now(), deployment.id),
    ]);
    if (!config.keep_builds && !simulate) await env.AIZZ_STORAGE.delete(buildKey);
    await log(env, batchId, deployment.deployment_id, "system", "info", `${deployment.domain} 部署成功`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.AIZZ_DB.batch([
      env.AIZZ_DB.prepare("UPDATE deployments SET status='failed',error_message=?,finished_at=?,updated_at=? WHERE id=?")
        .bind(message.slice(0, 2000), now(), now(), deployment.deployment_id),
      env.AIZZ_DB.prepare("UPDATE site_materials SET status='available',updated_at=? WHERE id=?")
        .bind(now(), deployment.id),
    ]);
    await log(env, batchId, deployment.deployment_id, "system", "error", message);
  }
  await refreshBatch(env, batchId);
  const remaining = await env.AIZZ_DB.prepare(
    "SELECT COUNT(*) count FROM deployments WHERE batch_id=? AND status='pending'",
  ).bind(batchId).first<{ count: number }>();
  return { done: Number(remaining?.count || 0) === 0, batch_id: batchId, deployment_id: deployment.deployment_id,
    domain: deployment.domain, remaining: Number(remaining?.count || 0) };
}

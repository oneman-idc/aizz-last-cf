const state = { user: null, csrf: "", version: "", page: "dashboard", resources: [], materials: [] };
const view = document.querySelector("#view");
const toastElement = document.querySelector("#toast");
const modal = document.querySelector("#modal");
const roleLabels = { admin: "管理员", operator: "操作员", viewer: "只读用户" };
const sourceLabels = {
  domain: "网站域名", site_name: "网站名称", site_url: "完整网址", keyword: "关键词",
  title: "SEO 标题", description: "SEO 描述", template_name: "模板名称",
  db_type: "数据库类型", db_host: "数据库主机", db_port: "数据库端口",
  db_name: "数据库名", db_user: "数据库用户", db_password: "数据库密码",
  random_chars_13: "随机字符（13 位）", random_letters_6_8: "随机字母（6-8 位）",
  tracking_code: "统计代码", custom: "自定义字段",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function toast(message, error = false) {
  toastElement.textContent = message;
  toastElement.className = `toast${error ? " error" : ""}`;
  toastElement.hidden = false;
  clearTimeout(toastElement.timer);
  toastElement.timer = setTimeout(() => { toastElement.hidden = true; }, 4500);
}

async function api(path, options = {}) {
  const request = { method: options.method || "GET", headers: new Headers(options.headers || {}) };
  if (options.form) request.body = options.form;
  if (options.body !== undefined) {
    request.headers.set("Content-Type", "application/json");
    request.body = JSON.stringify(options.body);
  }
  if (!['GET', 'HEAD'].includes(request.method)) request.headers.set("X-AIZZ-CSRF", state.csrf);
  const response = await fetch(`/api${path}`, request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    if (response.status === 428) navigate("profile");
    const message = data.error || `HTTP ${response.status}`;
    throw new Error(data.details ? `${message} ${data.details}` : message);
  }
  return data;
}

function showLogin() {
  state.user = null;
  state.csrf = "";
  document.querySelector("#app-shell").hidden = true;
  document.querySelector("#login-shell").hidden = false;
}

function showApp() {
  document.querySelector("#login-shell").hidden = true;
  document.querySelector("#app-shell").hidden = false;
  document.querySelector("#account-name").textContent = state.user.display_name || state.user.username;
  document.querySelector("#account-role").textContent = roleLabels[state.user.role];
  document.querySelector("#sidebar-version").textContent = `AIZZ Edge v${state.version}`;
  document.querySelectorAll("[data-admin-only]").forEach((item) => { item.hidden = state.user.role !== "admin"; });
}

function heading(title, description, action = "") {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</div>`;
}

function status(value) {
  return `<span class="status status-${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function empty(columns, message = "暂无记录") {
  return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}

async function navigate(page) {
  state.page = page;
  document.querySelectorAll("[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  document.querySelector("#sidebar").classList.remove("open");
  const titles = { dashboard: "系统概览", integrations: "API 授权仓", resources: "WEB 资源仓", materials: "网站材料仓", deployments: "合成与部署", logs: "批量执行记录", users: "用户管理", audit: "审计日志", profile: "修改密码" };
  document.querySelector("#breadcrumb").textContent = `控制台 / ${titles[page] || page}`;
  view.innerHTML = `<section class="panel"><div class="empty">正在读取...</div></section>`;
  try {
    const renderer = { dashboard: renderDashboard, integrations: renderIntegrations, resources: renderResources, materials: renderMaterials, deployments: renderDeployments, logs: renderLogs, users: renderUsers, audit: renderAudit, profile: renderProfile }[page];
    await renderer();
  } catch (error) {
    view.innerHTML = `<div class="alert alert-danger">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDashboard() {
  const data = await api("/dashboard");
  const resourceCount = Object.fromEntries(data.resources.map((row) => [row.kind, row.count]));
  const materialCount = Object.fromEntries(data.materials.map((row) => [row.status, row.count]));
  view.innerHTML = `${heading("系统概览", "Cloudflare Edge 资源与部署状态", '<button class="button primary" data-page="deployments">新建部署批次</button>')}
    <div class="metric-grid">
      <div class="metric"><span>内核源码</span><strong>${resourceCount.source || 0}</strong><small>R2 中可用资源</small></div>
      <div class="metric"><span>可用材料</span><strong>${materialCount.available || 0}</strong><small>已配对关键词与域名</small></div>
      <div class="metric"><span>已使用材料</span><strong>${materialCount.used || 0}</strong><small>真实部署成功</small></div>
      <div class="metric"><span>最近批次</span><strong>${data.batches.length}</strong><small>D1 持久化记录</small></div>
    </div>
    <section class="panel"><div class="panel-title"><h2>引导使用步骤</h2><span class="muted">按顺序准备即可开始批量建站</span></div>
      <div class="workflow">
        <button data-page="integrations"><strong>第一步：配置 API 及数据库源</strong><small>保存并测试 BT、Cloudflare 与共享网站数据库。</small></button>
        <button data-page="resources"><strong>第二步：配置源码 / 模板 / 插件</strong><small>上传 ZIP 并设置需要逐站替换的字段映射。</small></button>
        <button data-page="materials"><strong>第三步：导入网站材料并调整</strong><small>导入关键词和域名，按需调用 Workers AI。</small></button>
        <button data-page="deployments"><strong>第四步：合成与部署验证执行</strong><small>先模拟构建，再执行 BT 建站及 Cloudflare DNS。</small></button>
        <button data-page="logs"><strong>第五步：后期维护与更新细节</strong><small>检查逐站执行状态、错误信息和审计记录。</small></button>
      </div>
    </section>
    <div class="split-grid">
      <section class="panel"><div class="panel-title"><h2>最近部署批次</h2></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>成功 / 失败</th><th>创建时间</th></tr></thead><tbody>${data.batches.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${status(row.status)}</td><td>${row.success_count || 0} / ${row.failed_count || 0}</td><td>${escapeHtml(row.created_at)}</td></tr>`).join("") || empty(4)}</tbody></table></div></section>
      <section class="panel"><div class="panel-title"><h2>API 健康状态</h2></div><div class="table-wrap"><table><thead><tr><th>配置</th><th>类型</th><th>状态</th></tr></thead><tbody>${data.credentials.map((row) => `<tr><td>${escapeHtml(row.name)}<br><small class="muted">${escapeHtml(row.last_test_message || "尚未测试")}</small></td><td>${escapeHtml(row.kind)}</td><td>${status(row.last_test_status)}</td></tr>`).join("") || empty(3)}</tbody></table></div></section>
    </div>`;
}

async function renderIntegrations() {
  const [integrations, databases] = await Promise.all([api("/integrations"), api("/databases")]);
  view.innerHTML = `${heading("API 授权仓", "集中管理 BT、Cloudflare 及网站共享数据库")}
    <div class="alert alert-warning">Workers 无固定出口 IP。BT 面板建议通过 Cloudflare Tunnel 暴露为 HTTPS 443，并用 Access Service Token 保护；不要把 BT API 白名单开放到公网。</div>
    ${state.user.role === "admin" ? `<section class="panel"><div class="panel-title"><h2>添加 API 配置</h2></div><form id="integration-form" class="form-grid three">
      <label>API 类型<select name="kind" id="integration-kind"><option value="bt">BT 面板 API</option><option value="cloudflare">Cloudflare API</option></select><small>选择后只显示该服务所需字段。</small></label>
      <label>配置名称<input name="name" required placeholder="例如：主站服务器"><small>用于部署向导中识别。</small></label>
      <label data-bt-field>BT Tunnel 地址<input name="base_url" placeholder="https://bt-api.example.com"><small>必须是 Worker 可访问的 HTTPS 地址，不要填写内网 IP。</small></label>
      <label>API Key / Token<input name="secret" type="password" required autocomplete="new-password"><small>BT 填 API Key；Cloudflare 填具备 Zone:Read、DNS:Edit 的 API Token。</small></label>
      <label data-bt-field>Access Client ID<input name="access_client_id"><small>Cloudflare Access Service Token 的 Client ID。</small></label>
      <label data-bt-field>Access Client Secret<input name="access_client_secret" type="password" autocomplete="new-password"><small>与 BT API Key 一起加密保存，不会回显。</small></label>
      <label data-cf-field hidden>Cloudflare Account ID<input name="account_id"><small>可选；限制只查询该账号下的区域。</small></label>
      <div class="full"><button class="button primary">保存 API 配置</button></div>
    </form></section>` : ""}
    <section class="panel"><div class="panel-title"><h2>API 配置</h2></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>类型 / 地址</th><th>健康状态</th><th>操作</th></tr></thead><tbody>${integrations.rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>${escapeHtml(row.kind)}<br><small class="mono muted">${escapeHtml(row.base_url || "Cloudflare API v4")}</small></td><td>${status(row.last_test_status)}<br><small class="muted">${escapeHtml(row.last_test_message || "尚未测试")}</small></td><td><div class="actions"><button class="button small" data-test-integration="${row.id}">连接测试</button>${row.kind === "bt" ? `<button class="button small" data-bt-environment="${row.id}">读取环境</button>` : ""}${state.user.role === "admin" ? `<button class="button small danger" data-delete="integration:${row.id}">删除</button>` : ""}</div></td></tr>`).join("") || empty(4)}</tbody></table></div></section>
    <section class="panel"><div class="panel-title"><h2>网站共享数据库</h2></div>${state.user.role !== "viewer" ? `<form id="database-form" class="form-grid three">
      <label>配置名称<input name="name" required placeholder="例如：站群共享数据库"></label><label>数据库类型<select name="db_type"><option value="mysql">MySQL</option><option value="redis">Redis</option><option value="sqlite">SQLite 路径</option></select></label>
      <label>主机地址<input name="host" placeholder="10.0.0.8"><small>这里只生成到网站配置，不从 Worker 直连数据库。</small></label><label>端口<input name="port" type="number"></label><label>库名 / 路径<input name="database_name"></label><label>用户名<input name="username"></label><label>密码<input name="password" type="password" autocomplete="new-password"><small>AES-GCM 加密后存入 D1。</small></label>
      <div class="full"><button class="button primary">保存数据源</button></div></form>` : ""}<div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>连接信息</th><th>操作</th></tr></thead><tbody>${databases.rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.db_type)}</td><td class="mono">${escapeHtml(row.host)}:${row.port || ""}/${escapeHtml(row.database_name)}</td><td>${state.user.role === "admin" ? `<button class="button small danger" data-delete="database:${row.id}">删除</button>` : "-"}</td></tr>`).join("") || empty(4)}</tbody></table></div></section>`;
  const kind = document.querySelector("#integration-kind");
  kind?.addEventListener("change", () => {
    document.querySelectorAll("[data-bt-field]").forEach((item) => { item.hidden = kind.value !== "bt"; });
    document.querySelectorAll("[data-cf-field]").forEach((item) => { item.hidden = kind.value !== "cloudflare"; });
  });
  document.querySelector("#integration-form")?.addEventListener("submit", submitIntegration);
  document.querySelector("#database-form")?.addEventListener("submit", submitDatabase);
}

async function submitIntegration(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  await api("/integrations", { method: "POST", body });
  toast("API 配置已保存");
  renderIntegrations();
}

async function submitDatabase(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api("/databases", { method: "POST", body });
  toast("数据库源已保存");
  renderIntegrations();
}

function mappingRow(mapping = {}) {
  return `<div class="mapping-row">
    <label>文件路径<input data-map="path" value="${escapeHtml(mapping.path || "")}" placeholder="config.php"><small>留空表示全部文本文件</small></label>
    <label>匹配文本<input data-map="marker" value="${escapeHtml(mapping.marker || "")}" placeholder="{{AIZZ_DOMAIN}}" required></label>
    <label>值来源<select data-map="source">${Object.entries(sourceLabels).map(([value, label]) => `<option value="${value}" ${mapping.source === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label class="check-row"><input data-map="required" type="checkbox" ${mapping.required ? "checked" : ""}>必填</label>
    <button class="button small danger" type="button" data-remove-mapping>删除</button>
  </div>`;
}

function collectMappings(container) {
  return [...container.querySelectorAll(".mapping-row")].map((row) => ({
    path: row.querySelector('[data-map="path"]').value.trim(),
    marker: row.querySelector('[data-map="marker"]').value,
    source: row.querySelector('[data-map="source"]').value,
    required: row.querySelector('[data-map="required"]').checked,
  })).filter((item) => item.marker);
}

async function renderResources() {
  const data = await api("/resources");
  state.resources = data.rows;
  view.innerHTML = `${heading("WEB 资源仓", "内核源码、模板和插件统一保存到 Cloudflare R2")}
    <div class="alert alert-warning">免费方案单个 ZIP 限制 20MB、解压后限制 48MB。压缩包根目录必须存在 index.php、index.html 或 index.htm；模板和插件覆盖内核中的同名路径。</div>
    ${state.user.role !== "viewer" ? `<section class="panel"><div class="panel-title"><h2>上传资源</h2><span class="muted">标准 AIZZ 占位符会自动跨文本文件替换</span></div><form id="resource-form" class="form-grid three">
      <label>资源类型<select name="kind"><option value="source">WEB 内核源码</option><option value="template">WEB 模板</option><option value="plugin">WEB 插件</option></select></label>
      <label>资源名称<input name="name" required placeholder="例如：ThinkPHP 内核"></label><label>版本号<input name="version" value="1.0.0"></label>
      <label class="full">ZIP 文件<input name="file" type="file" accept=".zip,application/zip" required><small>上传内容将直接写入私有 R2，不会公开访问。</small></label>
      <div class="full"><div class="panel-title"><h2>字段映射</h2><button class="button small" type="button" data-add-mapping>添加映射</button></div><div class="panel-body" id="upload-mappings">${mappingRow({ source: "domain" })}</div></div>
      <div class="full"><button class="button primary">上传并保存</button></div>
    </form></section>` : ""}
    <section class="panel"><div class="panel-title"><h2>已保存资源</h2></div><div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>版本</th><th>大小 / 校验</th><th>字段映射</th><th>操作</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong><br><small class="muted">${escapeHtml(row.archive_name)}</small></td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.version)}</td><td>${(row.size_bytes / 1048576).toFixed(2)} MB<br><small class="mono muted">${escapeHtml(row.checksum.slice(0, 12))}</small></td><td>${JSON.parse(row.mapping_json || "[]").length} 项</td><td><div class="actions">${state.user.role !== "viewer" ? `<button class="button small" data-edit-mappings="${row.id}">字段映射</button>` : ""}${state.user.role === "admin" ? `<button class="button small danger" data-delete="resource:${row.id}">删除</button>` : ""}</div></td></tr>`).join("") || empty(6)}</tbody></table></div></section>`;
  document.querySelector("#resource-form")?.addEventListener("submit", submitResource);
}

async function submitResource(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  form.set("mapping_json", JSON.stringify(collectMappings(document.querySelector("#upload-mappings"))));
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = "正在上传...";
  try {
    await api("/resources", { method: "POST", form });
    toast("资源已上传到 R2");
    await renderResources();
  } finally {
    button.disabled = false;
  }
}

function editMappings(id) {
  const resource = state.resources.find((row) => row.id === id);
  if (!resource) return;
  const mappings = JSON.parse(resource.mapping_json || "[]");
  document.querySelector("#modal-content").innerHTML = `<div class="modal-head"><h2>${escapeHtml(resource.name)} / 字段映射</h2><button class="modal-close" type="button">×</button></div>
    <form id="mapping-form"><div class="toolbar"><span class="help">文件路径留空时会在所有可编辑文本文件中精确替换。</span><button class="button small" type="button" data-add-modal-mapping>添加映射</button></div><div class="panel-body" id="modal-mappings">${mappings.map(mappingRow).join("") || mappingRow({ source: "domain" })}</div><div class="panel-body actions"><button class="button primary">保存字段映射</button><button class="button" type="button" data-close-modal>取消</button></div></form>`;
  modal.showModal();
  document.querySelector("#mapping-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = collectMappings(document.querySelector("#modal-mappings"));
    await api(`/resources/${id}/mappings`, { method: "PUT", body: { mappings: values } });
    modal.close();
    toast("字段映射已更新");
    renderResources();
  });
}

async function renderMaterials() {
  const data = await api("/materials");
  state.materials = data.rows;
  const ready = data.rows.filter((row) => row.status === "available" && row.domain).length;
  view.innerHTML = `${heading("网站材料仓", "关键词、域名、网站名称和 SEO TDK 联动管理")}
    <section class="panel"><div class="panel-title"><h2>材料准备状态</h2><span class="muted">可直接部署 ${ready} 条</span></div>${state.user.role !== "viewer" ? `<form id="material-import-form" class="form-grid">
      <label>关键词（每行一个）<textarea name="keywords" rows="7" placeholder="网站建设&#10;云服务器"></textarea><small>导入后先生成本地合规标题与描述，可再调用 Workers AI 优化。</small></label>
      <label>域名（每行一个）<textarea name="domains" rows="7" placeholder="site-a.example.com&#10;site-b.example.com"></textarea><small>与关键词按行配对；单独导入域名时，会依次绑定已有未配域名材料。</small></label>
      <div class="full actions"><button class="button primary">一键导入</button><button class="button" type="button" id="generate-materials">Workers AI 生成前 10 条</button></div>
    </form>` : ""}</section>
    <section class="panel"><div class="panel-title"><h2>材料表</h2><span class="muted">最多显示最近 200 条</span></div><div class="table-wrap"><table><thead><tr><th>关键词 / 域名</th><th>网站名称</th><th>SEO 标题</th><th>描述</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td><strong>${escapeHtml(row.keyword)}</strong><br><small class="mono muted">${escapeHtml(row.domain || "待绑定域名")}</small></td><td>${escapeHtml(row.site_name)}</td><td>${escapeHtml(row.title)}</td><td><small>${escapeHtml(row.description)}</small></td><td>${status(row.status)}</td><td><div class="actions">${state.user.role !== "viewer" && row.status !== "used" ? `<button class="button small" data-edit-material="${row.id}">编辑</button>` : ""}${state.user.role === "admin" && row.status !== "used" ? `<button class="button small danger" data-delete-material="${row.id}">删除</button>` : ""}</div></td></tr>`).join("") || empty(6)}</tbody></table></div></section>`;
  document.querySelector("#material-import-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    const result = await api("/materials/import", { method: "POST", body });
    toast(`已写入 ${result.imported} 条材料操作`);
    renderMaterials();
  });
  document.querySelector("#generate-materials")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api("/materials/generate", { method: "POST", body: {} });
      toast(`Workers AI 已生成 ${result.generated} 条材料`);
      renderMaterials();
    } finally { event.currentTarget.disabled = false; }
  });
}

function editMaterial(id) {
  const row = state.materials.find((item) => item.id === id);
  if (!row) return;
  document.querySelector("#modal-content").innerHTML = `<div class="modal-head"><h2>编辑网站材料</h2><button class="modal-close" type="button">×</button></div><form id="material-edit-form" class="form-grid">
    <label>关键词<input name="keyword" value="${escapeHtml(row.keyword)}" required></label><label>域名<input name="domain" value="${escapeHtml(row.domain)}"></label><label>网站名称<input name="site_name" value="${escapeHtml(row.site_name)}" required></label><label>SEO 标题<input name="title" maxlength="70" value="${escapeHtml(row.title)}" required></label><label class="full">SEO 描述<textarea name="description" minlength="80" maxlength="160" rows="5" required>${escapeHtml(row.description)}</textarea><small>建议 80-160 字，内容应与关键词和标题相关。</small></label><div class="full actions"><button class="button primary">保存</button><button class="button" type="button" data-close-modal>取消</button></div></form>`;
  modal.showModal();
  document.querySelector("#material-edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api(`/materials/${id}`, { method: "PUT", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
    modal.close();
    toast("网站材料已更新");
    renderMaterials();
  });
}

async function deploymentOptions() {
  const [resources, integrations, databases] = await Promise.all([api("/resources"), api("/integrations"), api("/databases")]);
  return { resources: resources.rows, integrations: integrations.rows, databases: databases.rows };
}

async function renderDeployments() {
  const [data, options] = await Promise.all([api("/deployments"), deploymentOptions()]);
  const sources = options.resources.filter((row) => row.kind === "source");
  const templates = options.resources.filter((row) => row.kind === "template");
  const plugins = options.resources.filter((row) => row.kind === "plugin");
  const bt = options.integrations.filter((row) => row.kind === "bt" && row.enabled);
  const cf = options.integrations.filter((row) => row.kind === "cloudflare" && row.enabled);
  view.innerHTML = `${heading("合成与部署", "D1 保存进度，逐站执行可在中断后继续")}
    <div class="alert alert-warning">第一次必须保留“模拟执行”。真实部署会创建 BT 站点、上传源码并修改 Cloudflare DNS；建议先用 1 个测试域名验证。</div>
    ${state.user.role !== "viewer" ? `<section class="panel"><div class="panel-title"><h2>新建部署批次</h2><span class="muted">免费版每批最多 100 站</span></div><form id="deployment-form" class="form-grid three">
      <label>批次名称<input name="name" placeholder="例如：8 月内容站第一批"></label><label>站点数量<input name="count" type="number" min="1" max="100" value="1" required></label>
      <label>内核源码<select name="source_id" required><option value="">请选择</option>${sources.map((row) => `<option value="${row.id}">${escapeHtml(row.name)} v${escapeHtml(row.version)}</option>`).join("")}</select><small>每个站点都会复制完整内核。</small></label>
      <label>网站模板<select name="template"><option value="">不叠加模板</option><option value="random">随机模板</option>${templates.map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("")}</select><small>随机模板会为每个站独立分配已有模板。</small></label>
      <label>WEB 插件<select name="plugin_ids" multiple size="4">${plugins.map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("")}</select><small>按 Ctrl/Cmd 多选；插件在模板之后覆盖同名文件。</small></label>
      <label>共享数据库<select name="database_id"><option value="">不绑定</option>${options.databases.map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("")}</select></label>
      <label>BT API<select name="bt_credential_id"><option value="">模拟时可不选</option>${bt.map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("")}</select><small>真实部署必须选择并提前通过连接测试。</small></label>
      <label>Cloudflare API<select name="cf_credential_id"><option value="">不创建 DNS</option>${cf.map((row) => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join("")}</select></label>
      <label>DNS 类型<select name="dns_type"><option>A</option><option>AAAA</option><option>CNAME</option></select></label><label>DNS 解析目标<input name="dns_target" placeholder="服务器公网 IP 或目标域名"><small>系统写入后会通过 Record ID 回读验证。</small></label>
      <label>PHP 版本代码<input name="php_version" value="74"><small>先在 API 授权仓“读取环境”，按 BT 返回值填写。</small></label><label>BT 网站目录<input name="site_path_template" value="/www/wwwroot/{domain}"><small>仅支持 {domain} 和 {site_slug}。</small></label>
      <label class="check-row"><input name="simulate" type="checkbox" checked>模拟执行</label><label class="check-row"><input name="proxied" type="checkbox">开启 Cloudflare 代理</label><label class="check-row"><input name="keep_builds" type="checkbox">成功后保留 R2 构建包</label>
      <details class="full"><summary>高级配置</summary><div class="form-grid"><label class="full">Nginx 伪静态规则<textarea name="rewrite_rule" rows="8" placeholder="粘贴完整规则；留空则不修改"></textarea><small>真实部署后写入站点 rewrite 文件并回读验证。</small></label><label>必需文件（逗号分隔）<input name="required_files" placeholder="config.php,app/config.php"></label><label>逐站自定义 JSON<input name="custom" placeholder='{"API_ENDPOINT":"https://api.example.com"}'></label></div></details>
      <div class="full"><button class="button primary">创建部署批次</button></div>
    </form></section>` : ""}
    <section class="panel"><div class="panel-title"><h2>部署批次</h2><span class="muted">运行按钮会逐站调用，可关闭页面后继续</span></div><div class="table-wrap"><table><thead><tr><th>批次</th><th>状态</th><th>进度</th><th>时间</th><th>操作</th></tr></thead><tbody>${data.rows.map((row) => { const finished = (row.success_count || 0) + (row.failed_count || 0); const percent = row.domain_count ? Math.round(finished / row.domain_count * 100) : 0; return `<tr><td><strong>${escapeHtml(row.name)}</strong><br><small class="muted">#${row.id}</small></td><td>${status(row.status)}</td><td><div class="progress"><span style="width:${percent}%"></span></div><small>${finished}/${row.domain_count}，失败 ${row.failed_count || 0}</small></td><td>${escapeHtml(row.created_at)}</td><td><div class="actions"><button class="button small" data-batch-detail="${row.id}">详情</button>${state.user.role !== "viewer" && !['success'].includes(row.status) ? `<button class="button small primary" data-run-batch="${row.id}">${row.status === "running" ? "继续" : "执行"}</button>` : ""}${state.user.role !== "viewer" && row.failed_count ? `<button class="button small" data-retry-batch="${row.id}">重试失败站点</button>` : ""}${state.user.role === "admin" && row.status !== "success" ? `<button class="button small danger" data-delete-batch="${row.id}">删除</button>` : ""}</div></td></tr>`; }).join("") || empty(5)}</tbody></table></div></section>`;
  document.querySelector("#deployment-form")?.addEventListener("submit", submitDeployment);
}

async function submitDeployment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const template = data.get("template");
  let custom = {};
  try { custom = data.get("custom") ? JSON.parse(data.get("custom")) : {}; } catch { throw new Error("逐站自定义 JSON 格式无效"); }
  const body = {
    name: data.get("name"), count: Number(data.get("count")), source_id: Number(data.get("source_id")),
    template_id: template && template !== "random" ? Number(template) : null, random_template: template === "random",
    plugin_ids: data.getAll("plugin_ids").map(Number), database_id: data.get("database_id") ? Number(data.get("database_id")) : null,
    bt_credential_id: data.get("bt_credential_id") ? Number(data.get("bt_credential_id")) : null,
    cf_credential_id: data.get("cf_credential_id") ? Number(data.get("cf_credential_id")) : null,
    dns_type: data.get("dns_type"), dns_target: data.get("dns_target"), php_version: data.get("php_version"),
    site_path_template: data.get("site_path_template"), rewrite_rule: data.get("rewrite_rule"),
    required_files: String(data.get("required_files") || "").split(",").map((item) => item.trim()).filter(Boolean),
    simulate: data.has("simulate"), proxied: data.has("proxied"), keep_builds: data.has("keep_builds"), custom,
  };
  const result = await api("/deployments", { method: "POST", body });
  toast(`批次 #${result.id} 已创建，共 ${result.count} 个站点`);
  renderDeployments();
}

async function runBatch(id, button) {
  if (!confirm("确认执行此批次？真实模式会修改远端 BT 站点和 Cloudflare DNS。")) return;
  button.disabled = true;
  const original = button.textContent;
  try {
    let done = false;
    while (!done) {
      button.textContent = "逐站执行中...";
      const result = await api(`/deployments/${id}/run-next`, { method: "POST", body: {} });
      if (result.busy) { toast("此站点已被另一个页面领取，本页已停止执行"); break; }
      done = result.done;
      if (!done) button.textContent = `剩余 ${result.remaining}`;
    }
    toast("批次待执行站点已处理完毕");
    renderDeployments();
  } catch (error) {
    toast(`执行已暂停：${error.message}`, true);
    renderDeployments();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function showBatch(id) {
  const data = await api(`/deployments/${id}`);
  document.querySelector("#modal-content").innerHTML = `<div class="modal-head"><h2>${escapeHtml(data.batch.name)} / 站点明细</h2><button class="modal-close" type="button">×</button></div><div class="table-wrap"><table><thead><tr><th>域名</th><th>状态</th><th>BT 目录</th><th>错误</th></tr></thead><tbody>${data.sites.map((row) => `<tr><td class="mono">${escapeHtml(row.domain)}</td><td>${status(row.status)}</td><td class="mono">${escapeHtml(row.site_path || "-")}</td><td><small>${escapeHtml(row.error_message || "-")}</small></td></tr>`).join("")}</tbody></table></div><div class="panel-body"><button class="button" data-close-modal>关闭</button></div>`;
  modal.showModal();
}

async function renderLogs() {
  const data = await api("/logs");
  view.innerHTML = `${heading("批量执行记录", "最近 500 条逐站构建、BT 与 Cloudflare 操作记录")}
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>时间</th><th>批次 / 站点</th><th>通道</th><th>级别</th><th>消息</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td>${escapeHtml(row.created_at)}</td><td>#${row.batch_id || "-"} / ${row.deployment_id || "-"}</td><td>${escapeHtml(row.channel)}</td><td>${status(row.level)}</td><td>${escapeHtml(row.message)}</td></tr>`).join("") || empty(5)}</tbody></table></div></section>`;
}

async function renderUsers() {
  if (state.user.role !== "admin") throw new Error("仅管理员可访问用户管理");
  const data = await api("/users");
  view.innerHTML = `${heading("用户管理", "管理员、操作员与只读用户分权管理")}
    <section class="panel"><div class="panel-title"><h2>创建用户</h2></div><form id="user-form" class="form-grid three"><label>用户名<input name="username" required pattern="[A-Za-z0-9_.-]{3,32}"></label><label>显示名称<input name="display_name"></label><label>角色<select name="role"><option value="operator">操作员</option><option value="viewer">只读用户</option><option value="admin">管理员</option></select></label><label>初始密码<input name="password" type="password" minlength="12" required><small>至少 12 位并同时包含字母和数字；首次登录强制修改。</small></label><div class="full"><button class="button primary">创建用户</button></div></form></section>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td><strong>${escapeHtml(row.display_name || row.username)}</strong><br><small>${escapeHtml(row.username)}</small></td><td>${escapeHtml(roleLabels[row.role])}</td><td>${status(row.active ? "success" : "disabled")} ${row.force_password_change ? status("reserved") : ""}</td><td>${escapeHtml(row.last_login_at || "-")}</td><td><div class="actions"><button class="button small" data-toggle-user="${row.id}">${row.active ? "停用" : "启用"}</button><button class="button small" data-reset-user="${row.id}">重置密码</button></div></td></tr>`).join("")}</tbody></table></div></section>`;
  document.querySelector("#user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/users", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
    toast("用户已创建");
    renderUsers();
  });
}

async function renderAudit() {
  if (state.user.role !== "admin") throw new Error("仅管理员可访问审计日志");
  const data = await api("/audit");
  view.innerHTML = `${heading("审计日志", "登录、配置、材料与部署操作留痕")}
    <section class="panel"><div class="toolbar"><label class="check-row"><input type="checkbox" id="audit-all">全选当前 500 条</label><button class="button small danger" id="delete-audit">删除所选</button></div><div class="table-wrap"><table><thead><tr><th></th><th>时间</th><th>用户</th><th>操作</th><th>目标</th><th>来源 IP</th></tr></thead><tbody>${data.rows.map((row) => `<tr><td><input class="audit-check" type="checkbox" value="${row.id}"></td><td>${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.username || "系统")}</td><td class="mono">${escapeHtml(row.action)}</td><td>${escapeHtml(row.target_type)} #${escapeHtml(row.target_id)}</td><td class="mono">${escapeHtml(row.ip_address || "-")}</td></tr>`).join("") || empty(6)}</tbody></table></div></section>`;
  document.querySelector("#audit-all").addEventListener("change", (event) => document.querySelectorAll(".audit-check").forEach((item) => { item.checked = event.currentTarget.checked; }));
  document.querySelector("#delete-audit").addEventListener("click", async () => {
    const ids = [...document.querySelectorAll(".audit-check:checked")].map((item) => Number(item.value));
    if (!ids.length) throw new Error("请先勾选审计记录");
    if (!confirm(`确认删除所选 ${ids.length} 条审计记录？`)) return;
    await api("/audit", { method: "DELETE", body: { ids } });
    toast("审计记录已删除");
    renderAudit();
  });
}

async function renderProfile() {
  view.innerHTML = `${heading("修改密码", state.user.force_password_change ? "首次登录必须先设置自己的管理员密码" : "定期更换登录密码")}
    ${state.user.force_password_change ? '<div class="alert alert-warning">当前使用的是初始密码，完成修改后才能使用其他功能。</div>' : ""}
    <section class="panel"><form id="password-form" class="form-grid"><label>当前密码<input name="current_password" type="password" required autocomplete="current-password"></label><label>新密码<input name="new_password" type="password" minlength="12" required autocomplete="new-password"><small>至少 12 位，同时包含字母和数字。</small></label><label>确认新密码<input name="confirm_password" type="password" minlength="12" required autocomplete="new-password"></label><div class="full"><button class="button primary">更新密码</button></div></form></section>`;
  document.querySelector("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (body.new_password !== body.confirm_password) throw new Error("两次输入的新密码不一致");
    await api("/auth/password", { method: "POST", body });
    state.user.force_password_change = 0;
    toast("密码已更新");
    navigate("dashboard");
  });
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.page) return navigate(target.dataset.page);
    if (target.hasAttribute("data-add-mapping")) document.querySelector("#upload-mappings").insertAdjacentHTML("beforeend", mappingRow({ source: "domain" }));
    if (target.hasAttribute("data-add-modal-mapping")) document.querySelector("#modal-mappings").insertAdjacentHTML("beforeend", mappingRow({ source: "custom" }));
    if (target.hasAttribute("data-remove-mapping")) target.closest(".mapping-row").remove();
    if (target.dataset.editMappings) editMappings(Number(target.dataset.editMappings));
    if (target.dataset.editMaterial) editMaterial(Number(target.dataset.editMaterial));
    if (target.dataset.deleteMaterial) {
      if (confirm("确认删除此网站材料？")) { await api(`/materials/${target.dataset.deleteMaterial}`, { method: "DELETE", body: {} }); toast("材料已删除"); renderMaterials(); }
    }
    if (target.dataset.testIntegration) { const result = await api(`/integrations/${target.dataset.testIntegration}/test`, { method: "POST", body: {} }); toast(result.message); renderIntegrations(); }
    if (target.dataset.btEnvironment) { const result = await api(`/integrations/${target.dataset.btEnvironment}/environment`, { method: "POST", body: {} }); alert(JSON.stringify(result.result, null, 2)); renderIntegrations(); }
    if (target.dataset.delete) {
      const [type, id] = target.dataset.delete.split(":");
      if (confirm("确认删除此配置？正在被批次引用时系统会拒绝删除。")) { await api(`/${type === "integration" ? "integrations" : type === "database" ? "databases" : "resources"}/${id}`, { method: "DELETE", body: {} }); toast("已删除"); navigate(state.page); }
    }
    if (target.dataset.runBatch) runBatch(Number(target.dataset.runBatch), target);
    if (target.dataset.batchDetail) showBatch(Number(target.dataset.batchDetail));
    if (target.dataset.retryBatch) { await api(`/deployments/${target.dataset.retryBatch}/retry`, { method: "POST", body: {} }); toast("失败站点已恢复为待执行"); renderDeployments(); }
    if (target.dataset.deleteBatch && confirm("确认删除此非成功批次并释放已占用材料？")) { await api(`/deployments/${target.dataset.deleteBatch}`, { method: "DELETE", body: {} }); toast("部署批次已删除"); renderDeployments(); }
    if (target.dataset.toggleUser) { await api(`/users/${target.dataset.toggleUser}`, { method: "POST", body: { action: "toggle" } }); toast("用户状态已更新"); renderUsers(); }
    if (target.dataset.resetUser) { const password = prompt("输入至少 12 位、包含字母和数字的新密码："); if (password) { await api(`/users/${target.dataset.resetUser}`, { method: "POST", body: { action: "reset_password", password } }); toast("密码已重置，用户下次登录必须修改"); renderUsers(); } }
    if (target.classList.contains("modal-close") || target.hasAttribute("data-close-modal")) modal.close();
  } catch (error) { toast(error.message, true); }
});

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    const data = await response.json();
    if (!response.ok) {
      const message = data.error || "登录失败";
      throw new Error(data.details ? `${message} ${data.details}` : message);
    }
    state.user = data.user;
    state.csrf = data.user.csrf_token;
    const me = await api("/auth/me");
    state.version = me.version;
    showApp();
    navigate(state.user.force_password_change ? "profile" : "dashboard");
  } catch (error) { toast(error.message, true); }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST", body: {} }); } finally { showLogin(); }
});
document.querySelector("#menu-button").addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("open"));
modal.addEventListener("click", (event) => { if (event.target === modal) modal.close(); });
window.addEventListener("unhandledrejection", (event) => { event.preventDefault(); toast(event.reason?.message || String(event.reason), true); });

(async function initialize() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) return showLogin();
    const data = await response.json();
    state.user = data.user;
    state.csrf = data.user.csrf_token;
    state.version = data.version;
    showApp();
    navigate(state.user.force_password_change ? "profile" : "dashboard");
  } catch { showLogin(); }
})();

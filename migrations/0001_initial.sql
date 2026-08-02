CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('admin','operator','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  force_password_change INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_address TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('bt','cloudflare')),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  secret_data TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_test_status TEXT NOT NULL DEFAULT 'untested',
  last_test_message TEXT NOT NULL DEFAULT '',
  last_test_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS resource_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('source','template','plugin')),
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'unknown',
  object_key TEXT NOT NULL UNIQUE,
  archive_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mapping_json TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  site_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','used','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_material_domain_unique
  ON site_materials(domain) WHERE domain != '';

CREATE TABLE IF NOT EXISTS remote_databases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  db_type TEXT NOT NULL CHECK(db_type IN ('mysql','redis','sqlite')),
  host TEXT NOT NULL DEFAULT '',
  port INTEGER,
  database_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  secret_data TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','running','partial','success','failed','cancelled')),
  source_id INTEGER NOT NULL REFERENCES resource_packages(id),
  template_id INTEGER REFERENCES resource_packages(id),
  random_template INTEGER NOT NULL DEFAULT 0,
  database_id INTEGER REFERENCES remote_databases(id),
  bt_credential_id INTEGER REFERENCES api_credentials(id),
  cf_credential_id INTEGER REFERENCES api_credentials(id),
  config_json TEXT NOT NULL DEFAULT '{}',
  domain_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES deployment_batches(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES site_materials(id),
  template_id INTEGER REFERENCES resource_packages(id),
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','building','uploading','creating_site','creating_dns','success','failed')),
  build_object_key TEXT NOT NULL DEFAULT '',
  site_path TEXT NOT NULL DEFAULT '',
  bt_site_id TEXT NOT NULL DEFAULT '',
  cf_zone_id TEXT NOT NULL DEFAULT '',
  cf_record_id TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id, material_id)
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES deployment_batches(id) ON DELETE CASCADE,
  deployment_id INTEGER REFERENCES deployments(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'system',
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_blocked ON login_attempts(blocked_until);
CREATE INDEX IF NOT EXISTS idx_credentials_kind ON api_credentials(kind, enabled);
CREATE INDEX IF NOT EXISTS idx_resources_kind ON resource_packages(kind);
CREATE INDEX IF NOT EXISTS idx_databases_name ON remote_databases(name);
CREATE INDEX IF NOT EXISTS idx_materials_status ON site_materials(status, id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON deployment_batches(status, id);
CREATE INDEX IF NOT EXISTS idx_deployments_batch ON deployments(batch_id, status, id);
CREATE INDEX IF NOT EXISTS idx_task_logs_batch ON task_logs(batch_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  AIZZ_DB: D1Database;
  AIZZ_STORAGE: R2Bucket;
  ASSETS: Fetcher;
  AI: AiBinding;
  AIZZ_VERSION?: string;
  ENVIRONMENT?: string;
  INITIAL_ADMIN_PASSWORD: string;
  MASTER_KEY: string;
  SESSION_SECRET: string;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "operator" | "viewer";
  active: number;
  force_password_change: number;
}

export interface SessionUser extends User {
  csrf_token: string;
}

export interface ResourceMapping {
  path?: string;
  marker: string;
  source: string;
  default_value?: string;
  required?: boolean;
}

export interface ApiCredential {
  id: number;
  kind: "bt" | "cloudflare";
  name: string;
  base_url: string;
  secret_data: string;
  extra_json: string;
  enabled: number;
}

export type WaitUntil = (promise: Promise<unknown>) => void;

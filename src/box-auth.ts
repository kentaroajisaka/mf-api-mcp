import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { defaultOfficeCode } from "./rest.js";

const connectionSchema = z.object({
  office_name: z.string(),
  tenant_uid: z.string().regex(/^\d+$/),
  token_file: z.string().refine(isAbsolute, "token_file は絶対パスで指定してください"),
  owner_host: z.string().min(1),
  verification_file_id: z.string().uuid(),
});
const configSchema = z.object({ version: z.literal(1), connections: z.record(connectionSchema) });
const tokenSchema = z.object({
  clientId: z.string().min(1),
  scope: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.number().finite().positive(),
  authorizedAt: z.string().optional(),
}).passthrough();
export type BoxConnection = z.infer<typeof connectionSchema> & { office_code: string };
type Tokens = z.infer<typeof tokenSchema>;
export const BOX_READ = "mfc/box/files.read";
export const BOX_WRITE = "mfc/box/files.write";
export const BOX_TOKEN_URL = "https://api.biz.moneyforward.com/token";

export function boxConfigPath(): string {
  return process.env.MF_BOX_CONFIG ?? join(homedir(), ".mf-api-mcp", "cloudbox.json");
}

async function privateJson(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Box認証設定の形式が不正です");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error(`Box認証設定は本人所有・権限600にしてください: ${path}`);
  }
  // パーサーの例外に秘密の断片を含めない。
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`Box認証設定のJSONを読み取れません: ${path}`); }
}

export async function boxConnection(officeCode?: string): Promise<BoxConnection> {
  const office = officeCode?.trim() || defaultOfficeCode();
  if (!office || !/^\d{4}-\d{4}$/.test(office)) throw new Error("Boxの office_code（XXXX-XXXX）を指定してください");
  let raw: unknown;
  try { raw = await privateJson(boxConfigPath()); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Box未接続。READMEのCloudBox設定を行ってください");
    throw e;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Box接続設定の形式が不正です。READMEのCloudBox設定を確認してください");
  const connection = parsed.data.connections[office];
  if (!connection) throw new Error(`Box未接続: ${office}。別事業者の認証には切り替えません`);
  if (connection.owner_host !== hostname()) {
    throw new Error(`このBox認証の更新は ${connection.owner_host} に集約されています。そのMac上のMCPにSSH等で接続してください。認証ファイルのコピーは使えません`);
  }
  return { ...connection, token_file: await realpath(connection.token_file), office_code: office };
}

export async function readBoxTokens(connection: BoxConnection): Promise<Tokens> {
  const parsed = tokenSchema.safeParse(await privateJson(connection.token_file));
  if (!parsed.success) throw new Error("BoxのOAuth認証情報の形式が不正です");
  return parsed.data;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await open(temp, "wx", 0o600).then(async file => {
      try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
      finally { await file.close(); }
    });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await unlink(temp).catch(() => {}); }
}

function requireScopes(tokens: Tokens, scopes: string[]): void {
  const granted = new Set(tokens.scope.split(/\s+/));
  if (scopes.some(scope => !granted.has(scope))) throw new Error(`Boxに必要な権限がありません: ${scopes.join(" ")}`);
}

/** トークンは毎回ディスクから読み直し、同一ホストの複数MCP間でも更新を直列化する。 */
export async function boxAccessToken(connection: BoxConnection, scopes: string[], rejectedToken?: string): Promise<string> {
  let tokens = await readBoxTokens(connection);
  requireScopes(tokens, scopes);
  const usable = (value: Tokens) => value.expiresAt > Date.now() + 30_000 && value.accessToken !== rejectedToken;
  if (usable(tokens)) return tokens.accessToken;

  const lockPath = `${connection.token_file}.refresh.lock`;
  const deadline = Date.now() + 30_000;
  let lock;
  for (;;) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new Error("Boxの認証更新が使用中です。更新プロセスが停止している場合はrefresh.lockの所有PIDを確認してください。認証を繰り返さないでください");
      await delay(100);
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }));
    // ロック待ちの間に別プロセスが更新したトークンを使う。
    tokens = await readBoxTokens(connection);
    requireScopes(tokens, scopes);
    if (usable(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error("Boxの更新用トークンがありません。認証を持つMacで再接続が必要です");
    let response: Response;
    try {
      response = await fetch(BOX_TOKEN_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refreshToken }),
      });
    } catch { throw new Error("Box認証の更新結果を確認できません。自動再送はしていません。認証を持つMacで接続状態を確認してください"); }
    if (!response.ok) {
      // OAuthのレスポンス本文や秘密をエラーに出さない。
      throw new Error(`Box認証の更新に失敗しました（HTTP ${response.status}）。失効・解除の場合は認証を持つMacで再接続が必要です`);
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error("Box認証の更新応答を読み取れません。再接続が必要です"); }
    const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string().optional() }).safeParse(raw);
    if (!parsed.success) throw new Error("Box認証の更新応答の形式が不正です。再接続が必要です");
    const updated: Tokens = { ...tokens, accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000, scope: parsed.data.scope ?? tokens.scope };
    // スコープ変更があっても、ローテーション済みトークンは先に保存する。
    await writePrivateJson(connection.token_file, updated);
    requireScopes(updated, scopes);
    return updated.accessToken;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

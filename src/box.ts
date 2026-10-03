import { constants } from "node:fs";
import { access, link, open, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BOX_READ, BOX_WRITE, boxAccessToken, boxConnection, readBoxTokens, type BoxConnection } from "./box-auth.js";
import { cloudBoxFileUrls } from "./evidence-urls.js";

export const BOX_BASE = "https://api.box.moneyforward.com/v1/files";
const MAX_BYTES = 50 * 1024 * 1024; // MCP側の上限。MFサービスの上限を示すものではない。
const idSchema = z.string().uuid();
const fileSchema = z.object({ file_id: idSchema, tenant_uid: z.union([z.string(), z.number()]),
  file_name: z.string(), content_length: z.number().int().nonnegative(), is_trashed: z.boolean() }).passthrough();
type BoxFile = z.infer<typeof fileSchema>;

function fileId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new Error("Box file_id はAPIが返したUUIDを指定してください");
  return parsed.data;
}

function checkedFile(raw: unknown, connection: BoxConnection): BoxFile {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Boxファイル応答の形式が不正です");
  if (String(parsed.data.tenant_uid) !== connection.tenant_uid) throw new Error("Boxの事業者が接続設定と一致しません。操作を中止しました");
  return parsed.data;
}

async function boxError(response: Response, mutation = false): Promise<never> {
  let code = "";
  try {
    const data = await response.json() as { errors?: { code?: string }[] };
    code = (data.errors ?? []).map(e => e.code).filter(c => typeof c === "string" && /^[A-Z_]{1,100}$/.test(c)).join(", ");
  } catch { /* 本文に署名URLや認証情報があっても表示しない */ }
  let detail = code ? `: ${code}` : "";
  if (code.includes("INTERNAL_FILE_ACCESS_NOT_ALLOWED")) detail += "。MF内部システム由来のファイルはAPIダウンロード対象外です。APIで保存したファイルは取得できることを確認しています";
  if (mutation && response.status >= 500) detail += "。保存済みの可能性があります。再送前に一覧を照合してください";
  throw new Error(`CloudBox HTTP ${response.status}${detail}`);
}

async function request(connection: BoxConnection, path: string, method: "GET" | "POST" = "GET", body?: FormData): Promise<Response> {
  const scopes = method === "GET" ? [BOX_READ] : [BOX_READ, BOX_WRITE];
  let token = await boxAccessToken(connection, scopes);
  const send = () => fetch(BOX_BASE + path, { method, body, redirect: "manual", signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  try {
    let response = await send();
    if (response.status === 401 && method === "GET") {
      await response.body?.cancel();
      token = await boxAccessToken(connection, scopes, token);
      response = await send();
    }
    return response;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Box")) throw e;
    throw new Error(method === "POST" ? "Box保存の通信結果が不明です。重複を避けるため再送前に一覧を照合してください" : "Boxへの通信に失敗しました");
  }
}

async function metadata(connection: BoxConnection, id: string): Promise<BoxFile> {
  const response = await request(connection, `/${fileId(id)}`);
  if (!response.ok) return boxError(response);
  const data = await response.json();
  const file = checkedFile(data.file ?? data, connection);
  if (file.file_id !== id) throw new Error("Box応答のfile_idが要求と一致しません");
  return file;
}

export async function boxStatus(officeCode?: string, verify = false) {
  const connection = await boxConnection(officeCode);
  if (verify) await metadata(connection, connection.verification_file_id);
  const tokens = await readBoxTokens(connection);
  return { office_code: connection.office_code, office_name: connection.office_name, tenant_uid: connection.tenant_uid,
    owner_host: connection.owner_host, scopes: tokens.scope.split(/\s+/), expires_at: new Date(tokens.expiresAt).toISOString(),
    automatic_refresh: Boolean(tokens.refreshToken), api_verified: verify };
}

export async function boxGetFile(id: string, officeCode?: string) {
  return { ...await metadata(await boxConnection(officeCode), id), urls: cloudBoxFileUrls(id) };
}

export async function boxListFiles(officeCode?: string, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page は1以上の整数で指定してください");
  const connection = await boxConnection(officeCode);
  const response = await request(connection, page === 1 ? "" : `?page=${page}`);
  if (!response.ok) return boxError(response);
  const data = await response.json();
  if (!Array.isArray(data.files)) throw new Error("Boxファイル一覧の形式が不正です");
  return { ...data, files: data.files.map((file: unknown) => checkedFile(file, connection)) };
}

export async function boxUploadFile(path: string, officeCode?: string, fileName?: string, mimeType?: string) {
  if (!isAbsolute(path)) throw new Error("local_path はMCPを動かすMac上の絶対パスで指定してください");
  const name = fileName ?? basename(path);
  if (!name || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error("file_name にパスや制御文字は指定できません");
  const mime = mimeType ?? ({ ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff" }[extname(name).toLowerCase()]);
  if (!mime || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime)) throw new Error("mime_type を指定してください");
  const source = await open(path, "r");
  let bytes: Buffer;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) throw new Error("アップロードは1バイト〜50MiBの通常ファイルに対応しています（MCP側の制限）");
    bytes = await source.readFile();
    if (bytes.length !== info.size || bytes.length > MAX_BYTES) throw new Error("読み取り中にファイルサイズが変わりました。再確認してください");
  } finally { await source.close(); }
  const connection = await boxConnection(officeCode);
  // 書き込み前に、認可先が登録時に確認した事業者であることをMFの応答で照合する。
  await metadata(connection, connection.verification_file_id);
  const body = new FormData();
  body.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  body.set("metadata", JSON.stringify({ file_name: name }));
  const response = await request(connection, "", "POST", body);
  if (!response.ok) return boxError(response, true);
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Boxは保存成功を返しましたが応答を読み取れません。再送前に一覧を照合してください"); }
  const file = checkedFile(data.file ?? data, connection);
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), uploaded_bytes: bytes.length,
    journal_linked: false, note: "仕訳への紐づけはMF画面の「クラウドBoxから選択」で行います。取引情報・電帳法区分は設定していません" };
}

export async function boxDownloadFile(id: string, outputPath: string, officeCode?: string) {
  if (!isAbsolute(outputPath)) throw new Error("output_path はMCPを動かすMac上の絶対パスで指定してください");
  try { await access(outputPath, constants.F_OK); throw new Error("保存先ファイルが既に存在します。上書きしません"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const connection = await boxConnection(officeCode);
  const file = await metadata(connection, id);
  if (file.content_length > MAX_BYTES) throw new Error("ダウンロードは50MiBまで対応しています（MCP側の制限）");
  let response = await request(connection, `/${fileId(id)}/download`);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let target: URL;
    try { target = new URL(location ?? ""); } catch { throw new Error("Boxのダウンロード先が不正です"); }
    if (target.protocol !== "https:" || target.username || target.password || target.port ||
      !(target.hostname === "api.box.moneyforward.com" || /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(target.hostname))) {
      throw new Error("Boxのダウンロード先が想定外です。認証情報は転送していません");
    }
    try {
      // 署名URLは出力しない。MF BearerをS3へ転送しない。二段目のリダイレクトも追わない。
      response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(45_000) });
    } catch { throw new Error("Boxファイル本体の取得に失敗しました"); }
  }
  if (!response.ok) return boxError(response);
  if (!response.body) throw new Error("Boxファイル本体が空です");
  const temp = join(dirname(outputPath), `.mf-box-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let length = 0;
  try {
    const dest = await open(temp, "wx", 0o600);
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.byteLength;
        if (length > MAX_BYTES || length > file.content_length) throw new Error("Boxのファイルサイズがメタデータと一致しません");
        hash.update(chunk);
        await dest.writeFile(chunk);
      }
      if (length !== file.content_length) throw new Error("Boxのファイル本体を全て取得できませんでした");
      await dest.sync();
    } finally { await dest.close(); }
    // 途中失敗では完成ファイルを作らず、競合して保存先が作られた場合も上書きしない。
    await link(temp, outputPath);
  } finally { await unlink(temp).catch(() => {}); }
  return { office_code: connection.office_code, file_id: id, file_name: file.file_name,
    output_path: outputPath, bytes: length, sha256: hash.digest("hex") };
}

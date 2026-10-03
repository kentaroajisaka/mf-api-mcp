import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { boxAccessToken, boxConnection } from "../dist/box-auth.js";

const office = "1234-5678";
const fileId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const apiBase = "https://api.box.moneyforward.com/v1/files";
const tokenUrl = "https://api.biz.moneyforward.com/token";
const pdf = Buffer.from("%PDF-1.4\nCloudBox roundtrip fixture\n");
const scopes = "mfc/box/files.read mfc/box/files.write";
const file = { file_id: fileId, tenant_uid: 321, file_name: "テスト.pdf", content_length: pdf.length, is_trashed: false };
const originalFetch = globalThis.fetch;
const originalConfig = process.env.MF_BOX_CONFIG;
const originalOffice = process.env.MF_OFFICE_CODE;
let root, tokenFile, connection, client, server;
let requests = [];
const privateWrite = (path, data) => writeFile(path, JSON.stringify(data), { mode: 0o600 });
const freshTokens = () => ({ clientId: "client-for-tests", scope: scopes, accessToken: "access-secret-OLD",
  refreshToken: "refresh-secret-OLD", expiresAt: Date.now() + 3_600_000 });
const tokensResponse = () => Response.json({ access_token: "access-secret-NEW", refresh_token: "refresh-secret-NEW", expires_in: 3600, scope: scopes });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "mf-cloudbox-test-"));
  tokenFile = join(root, "token.json");
  process.env.MF_BOX_CONFIG = join(root, "connections.json");
  delete process.env.MF_OFFICE_CODE;
  connection = { office_name: "テスト事業者", tenant_uid: "321", token_file: tokenFile,
    owner_host: hostname(), verification_file_id: fileId };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createServer();
  client = new Client({ name: "cloudbox-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

beforeEach(async () => {
  await privateWrite(process.env.MF_BOX_CONFIG, { version: 1, connections: { [office]: connection } });
  await privateWrite(tokenFile, freshTokens());
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    throw new Error("Unexpected network request in test");
  };
});

after(async () => {
  await client?.close();
  await server?.close();
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.MF_BOX_CONFIG; else process.env.MF_BOX_CONFIG = originalConfig;
  if (originalOffice === undefined) delete process.env.MF_OFFICE_CODE; else process.env.MF_OFFICE_CODE = originalOffice;
  await rm(root, { recursive: true, force: true });
});

function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return handler(String(url), init);
  };
}

async function call(name, args = {}, errorPattern) {
  const response = await client.callTool({ name: `mfc_box_${name}`, arguments: { office_code: office, ...args } });
  const message = response.content[0].text;
  if (errorPattern) {
    assert.equal(response.isError, true, message);
    assert.match(message, errorPattern);
    assert.doesNotMatch(message, /access-secret|refresh-secret/);
    return message;
  }
  assert.notEqual(response.isError, true, message);
  return JSON.parse(message);
}

test("MCPがBoxの6ツールを公開し、秘密を返さず接続状態を表示する", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter(x => x.name.startsWith("mfc_box_")).map(x => x.name).sort(),
    ["authStatus", "getFiles", "getFile", "uploadFile", "downloadFile", "fileUrls"].map(x => "mfc_box_" + x).sort());
  assert.equal(tools.find(x => x.name === "mfc_box_uploadFile").annotations.readOnlyHint, false);
  const result = await call("authStatus");
  assert.equal(result.automatic_refresh, true);
  assert.equal(result.tenant_uid, "321");
  assert.doesNotMatch(JSON.stringify(result), /access-secret|refresh-secret/);
  assert.equal(requests.length, 0);
});

test("添付IDからブラウザ用URLをOAuth接続なし・通信なしで生成する", async () => {
  await privateWrite(process.env.MF_BOX_CONFIG, { version: 1, connections: {} });
  const response = await client.callTool({ name: "mfc_box_fileUrls", arguments: { file_id: fileId } });
  assert.notEqual(response.isError, true);
  const urls = JSON.parse(response.content[0].text);
  assert.equal(urls.file_id, fileId);
  assert.equal(urls.web_download_url, `https://box.moneyforward.com/frontend/v3/files/${fileId}/download`);
  assert.equal(urls.web_auth, "authenticated_CloudBox_browser_session");
  assert.equal(requests.length, 0);
  assert.doesNotMatch(JSON.stringify(urls), /access-secret|refresh-secret/);
});

test("別Macへコピーした認証・未登録の事業者でAPIを呼ばない", async () => {
  await privateWrite(process.env.MF_BOX_CONFIG, { version: 1, connections: { [office]: { ...connection, owner_host: "another-Mac" } } });
  await call("getFile", { file_id: fileId }, /別|another-Mac/);
  await call("getFile", { office_code: "9999-9999", file_id: fileId }, /Box未接続/);
  assert.equal(requests.length, 0);
});

test("別事業者の応答では書き込みを開始しない", async () => {
  const input = join(root, "wrong-tenant.pdf");
  await writeFile(input, pdf);
  mockFetch(() => Response.json({ ...file, tenant_uid: 999 }));
  await call("uploadFile", { local_path: input }, /事業者.*一致/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, "GET");
});

test("write権限なしではアップロードを開始しない", async () => {
  await privateWrite(tokenFile, { ...freshTokens(), scope: "mfc/box/files.read" });
  const input = join(root, "read-only.pdf");
  await writeFile(input, pdf);
  mockFetch(() => Response.json(file));
  await call("uploadFile", { local_path: input }, /権限がありません/);
  assert.ok(requests.every(x => x.init.method === "GET"));
});

test("一覧のページ送りとMF_OFFICE_CODEの既定値を利用できる", async () => {
  mockFetch(url => {
    assert.equal(url, `${apiBase}?page=2`);
    return Response.json({ files: [file], pagination: { next_page: 3 } });
  });
  process.env.MF_OFFICE_CODE = office;
  try {
    const result = await call("getFiles", { office_code: undefined, page: 2 });
    assert.equal(result.pagination.next_page, 3);
    assert.equal(result.files[0].file_id, fileId);
  } finally { delete process.env.MF_OFFICE_CODE; }
});

test("アップロードはJSON文字列のmetadataと元バイト列をmultipartで一度だけ送る", async () => {
  const input = join(root, "upload.pdf");
  await writeFile(input, pdf);
  mockFetch(async (url, init) => {
    if (init.method === "GET") return Response.json(file);
    assert.equal(url, apiBase);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], undefined);
    assert.equal(typeof init.body.get("metadata"), "string");
    assert.deepEqual(JSON.parse(init.body.get("metadata")), { file_name: "証憑.pdf" });
    assert.deepEqual(Buffer.from(await init.body.get("file").arrayBuffer()), pdf);
    return Response.json({ ...file, file_id: secondId }, { status: 201 });
  });
  const result = await call("uploadFile", { local_path: input, file_name: "証憑.pdf" });
  assert.equal(result.file.file_id, secondId);
  assert.equal(result.journal_linked, false);
  assert.equal(result.sha256, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(requests.filter(x => x.init.method === "POST").length, 1);
});

test("アップロードの通信結果が不明でも再送しない", async () => {
  const input = join(root, "uncertain.pdf");
  await writeFile(input, pdf);
  mockFetch((url, init) => {
    if (init.method === "GET") return Response.json(file);
    throw new Error("fetch failed with secret URL");
  });
  await call("uploadFile", { local_path: input }, /結果が不明.*重複/);
  assert.equal(requests.filter(x => x.init.method === "POST").length, 1);
});

test("署名URLへのリダイレクトにBearerを渡さず、元PDFとハッシュが一致する", async () => {
  const output = join(root, "download.pdf");
  const signed = "https://s3.ap-northeast-1.amazonaws.com/test-bucket/object?signature=do-not-expose";
  mockFetch((url, init) => {
    if (url === `${apiBase}/${fileId}`) return Response.json(file);
    if (url === `${apiBase}/${fileId}/download`) return new Response(null, { status: 307, headers: { Location: signed } });
    assert.equal(url, signed);
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, "error");
    return new Response(pdf);
  });
  const result = await call("downloadFile", { file_id: fileId, output_path: output });
  assert.deepEqual(await readFile(output), pdf);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(result.sha256, createHash("sha256").update(pdf).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), /signature|do-not-expose/);
});

test("既存の保存先を上書きせず、APIも呼ばない", async () => {
  const output = join(root, "existing.pdf");
  await writeFile(output, "preserve");
  await call("downloadFile", { file_id: fileId, output_path: output }, /既に存在/);
  assert.equal(await readFile(output, "utf8"), "preserve");
  assert.equal(requests.length, 0);
});

test("破損・途中切れのダウンロードを完成ファイルとして残さない", async () => {
  const output = join(root, "truncated.pdf");
  mockFetch(url => url.endsWith("/download") ? new Response(pdf.subarray(0, 5)) : Response.json(file));
  await call("downloadFile", { file_id: fileId, output_path: output }, /全て取得できません/);
  await assert.rejects(stat(output), { code: "ENOENT" });
  assert.ok(!(await readdir(root)).some(x => x.startsWith(".mf-box-")));
});

test("内部システム由来のファイルが拒否された理由を返す", async () => {
  mockFetch(url => url.endsWith("/download")
    ? Response.json({ errors: [{ code: "INTERNAL_FILE_ACCESS_NOT_ALLOWED" }] }, { status: 403 }) : Response.json(file));
  await call("downloadFile", { file_id: fileId, output_path: join(root, "internal.pdf") }, /INTERNAL_FILE_ACCESS_NOT_ALLOWED/);
  assert.equal(requests.length, 2);
});

test("想定外のダウンロード先へリクエストを送らない", async () => {
  mockFetch(url => url.endsWith("/download")
    ? new Response(null, { status: 307, headers: { Location: "https://evil.example/secret" } }) : Response.json(file));
  await call("downloadFile", { file_id: fileId, output_path: join(root, "evil.pdf") }, /想定外/);
  assert.equal(requests.length, 2);
});

test("GETで401になったトークンを一度だけ更新し、回転したrefresh tokenを保存する", async () => {
  mockFetch((url, init) => {
    if (url === tokenUrl) {
      assert.equal(init.body.get("refresh_token"), "refresh-secret-OLD");
      return tokensResponse();
    }
    return init.headers.Authorization.endsWith("OLD") ? new Response(null, { status: 401 }) : Response.json(file);
  });
  const result = await call("getFile", { file_id: fileId });
  assert.equal(result.file_id, fileId);
  assert.equal(requests.filter(x => x.url === tokenUrl).length, 1);
  assert.equal(JSON.parse(await readFile(tokenFile, "utf8")).refreshToken, "refresh-secret-NEW");
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
});

test("期限切れの同時リクエストでは更新を一度だけ行う", async () => {
  await privateWrite(tokenFile, { ...freshTokens(), expiresAt: 1 });
  mockFetch(async url => {
    assert.equal(url, tokenUrl);
    await new Promise(resolve => setTimeout(resolve, 150));
    return tokensResponse();
  });
  const conn = await boxConnection(office);
  const results = await Promise.all(Array.from({ length: 4 }, () => boxAccessToken(conn, ["mfc/box/files.read"])));
  assert.ok(results.every(x => x === "access-secret-NEW"));
  assert.equal(requests.length, 1);
});

test("別々のNodeプロセスでも同じrefresh tokenを二重使用しない", async () => {
  await privateWrite(tokenFile, { ...freshTokens(), expiresAt: 1 });
  const events = join(root, "refresh-events.txt");
  const source = `
    import { appendFile } from 'node:fs/promises';
    import { boxAccessToken, boxConnection } from ${JSON.stringify(new URL("../dist/box-auth.js", import.meta.url).href)};
    globalThis.fetch = async () => {
      await appendFile(${JSON.stringify(events)}, 'refresh\\n');
      await new Promise(r => setTimeout(r, 200));
      return Response.json({access_token:'new-cross-process',refresh_token:'new-refresh',expires_in:3600,scope:${JSON.stringify(scopes)}});
    };
    const token=await boxAccessToken(await boxConnection(${JSON.stringify(office)}), ['mfc/box/files.read']);
    if(token!=='new-cross-process') process.exitCode=2;
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Child failed: ${code} ${output}`)));
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(await readFile(events, "utf8"), "refresh\n");
});

test("OAuth更新エラーから秘密や応答本文を出力しない", async () => {
  await privateWrite(tokenFile, { ...freshTokens(), expiresAt: 1 });
  mockFetch(() => Response.json({ error: "invalid_grant", error_description: "refresh-secret-OLD" }, { status: 400 }));
  await call("authStatus", { verify: true }, /HTTP 400/);
  assert.equal(requests.length, 1);
  await assert.rejects(stat(tokenFile + ".refresh.lock"), { code: "ENOENT" });
});

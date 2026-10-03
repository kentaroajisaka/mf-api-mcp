import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boxDownloadFile, boxGetFile, boxListFiles, boxStatus, boxUploadFile } from "./box.js";
import { cloudBoxFileUrls } from "./evidence-urls.js";

const office = { office_code: z.string().regex(/^\d{4}-\d{4}$/).optional().describe("事業者番号。省略時はMF_OFFICE_CODE。Boxは事業者ごとのOAuth接続が必要") };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
async function result(work: () => Promise<unknown>) {
  try { return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] }; }
  catch (e) { return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : "Box処理に失敗しました"}` }], isError: true }; }
}

export function registerBoxTools(server: McpServer): void {
  server.registerTool("mfc_box_fileUrls", {
    description: "仕訳GETのvoucher_file_idsから受け取った添付ファイルIDで、CloudBox詳細画面・ブラウザ用ダウンロード・公開API用ダウンロードのURLを生成。IDは推測しません。ブラウザ用は https://box.moneyforward.com/frontend/v3/files/{file_id}/download で、アクセス権のあるログイン済みブラウザから取得してください。Box APIでINTERNAL_FILE_ACCESS_NOT_ALLOWEDとなる添付1件もこのブラウザ経路で原本取得・SHA-256一致を検証済み。URL生成のみで通信・認証・本体取得は行わず、全ファイルの取得を保証しません。OAuth認証は不要。署名付きURLは生成・保存しません。",
    inputSchema: { file_id: z.string().uuid().describe("仕訳GETのvoucher_file_idsの要素、または既存CloudBox詳細URLのファイルID") },
    annotations: { ...readOnly, openWorldHint: false },
  }, args => result(async () => cloudBoxFileUrls(args.file_id)));
  server.registerTool("mfc_box_authStatus", {
    description: "CloudBoxの接続先・権限・自動更新の状態を確認。秘密は表示しません。verify=trueでAPI疎通と事業者を照合します。",
    inputSchema: { ...office, verify: z.boolean().optional() }, annotations: readOnly,
  }, args => result(() => boxStatus(args.office_code, args.verify)));
  server.registerTool("mfc_box_getFiles", {
    description: "CloudBoxのファイル一覧。pagination.next_pageがある場合はその値をpageに渡して続きを取得します。",
    inputSchema: { ...office, page: z.number().int().positive().optional() }, annotations: readOnly,
  }, args => result(() => boxListFiles(args.office_code, args.page)));
  server.registerTool("mfc_box_getFile", {
    description: "CloudBoxのファイル情報と取得候補URLを返します。MF仕訳のvoucher_file_idsの要素はBoxのfile_idとして扱えます。情報APIで拒否される場合もmfc_box_fileUrlsで通信なしにブラウザ用URLを生成できます。本体取得の確認は別途必要です。",
    inputSchema: { ...office, file_id: z.string().uuid() }, annotations: readOnly,
  }, args => result(() => boxGetFile(args.file_id, args.office_code)));
  server.registerTool("mfc_box_uploadFile", {
    description: "MCPホスト上の原本をCloudBox APIで保存します。downloadFileで本体取得と原本のSHA-256一致を確認してください。ユーザーが2件保存＋メモURL方式を選んだ場合は、このfile_idの通常URL https://box.moneyforward.com/files/{file_id} を仕訳メモmemoへ既存内容を残して追記し、同じ原本を会計APIのpostVouchersで添付用として別途保存・添付します。取得用と添付用は別IDです。このBoxファイル1件をそのまま添付する場合はMF画面の『クラウドBoxから選択』を使います。Box保存だけでは仕訳添付は完了しません。取引情報・電帳法区分は未設定。通信結果不明時は自動再送せず一覧照合。上限50MiB。",
    inputSchema: { ...office, local_path: z.string(), file_name: z.string().optional(), mime_type: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => result(() => boxUploadFile(args.local_path, args.office_code, args.file_name, args.mime_type)));
  server.registerTool("mfc_box_downloadFile", {
    description: "CloudBox OAuth APIで本体を取得しMCPホスト上の指定パスへ保存。既存ファイルは上書きせずSHA-256を返します。INTERNAL_FILE_ACCESS_NOT_ALLOWEDの場合はAPI再試行を重ねず、mfc_box_fileUrlsで同じIDのブラウザ用URLを生成し、ログイン済みブラウザで取得を試せます。画面用URLの認証とOAuth認証は別で、このツールはブラウザ取得を行いません。上限50MiB。",
    inputSchema: { ...office, file_id: z.string().uuid(), output_path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => result(() => boxDownloadFile(args.file_id, args.output_path, args.office_code)));
}

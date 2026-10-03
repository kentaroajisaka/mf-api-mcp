import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runDepartments, runReconcile, runScan, runVerify, scanSchema } from "./bookkeeping-runner.js";

export function registerBookkeepingTools(server: McpServer) {
  const path = z.string().min(1).describe("MCPホスト上の絶対パス");
  const result = async (work: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await work()) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] }; }
  };
  server.tool("mf_bookkeeping_scan",
    "読み取り専用。未仕訳・年度仕訳・口座設定・科目・証憑ID・試算表を一括取得してローカル照合。未仕訳0件は最小取得で終了。登録済み明細監査や処理前残高取得にはaudit_links=true。出力は候補であり帳簿・対象外ステータスは変更しない。",
    { ...scanSchema.shape, output_dir: path, config_file: path.optional(), resume_cache: path.optional() },
    ({ output_dir, config_file, resume_cache, ...input }) => result(() => runScan(input, output_dir, config_file, resume_cache)));
  server.tool("mf_bookkeeping_reconcile", "取得済みスナップショットと外部設定を使って再照合。API再取得なし。",
    { snapshot_file: path, output_dir: path, config_file: path.optional() },
    ({ snapshot_file, output_dir, config_file }) => result(() => runReconcile(snapshot_file, output_dir, config_file)));
  server.tool("mf_bookkeeping_verify", "処理後に対象仕訳だけ実GETし、明細状態・未仕訳件数・BS/PLの処理前後差分を一括確認。manifestで事業者と対象IDを明示。",
    { snapshot_file: path, manifest_file: path, output_dir: path },
    ({ snapshot_file, manifest_file, output_dir }) => result(() => runVerify(snapshot_file, manifest_file, output_dir)));
  server.tool("mf_bookkeeping_departments", "取得済み年度仕訳を借方・貸方の部門ID別、科目・補助科目別に集計。部門未設定を含む。期首残高は推定せず、opening_fileを渡した組だけ期末残高も算出。API再取得なし。",
    { snapshot_file: path, output_dir: path, opening_file: path.optional() },
    ({ snapshot_file, output_dir, opening_file }) => result(() => runDepartments(snapshot_file, output_dir, opening_file)));
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { api, encodePathId, defaultOfficeCode } from "./rest.js";
import { listOffices, getJwt, readApiKey } from "./apikey.js";

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

/** 全ツール共通。APIキー認証では事業者番号が必須。 */
const officeParam = {
  office_code: z
    .string()
    .optional()
    .describe("対象事業者の事業者番号（XXXX-XXXX）。APIキー認証では必須。MF_OFFICE_CODE を設定していれば省略可"),
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mf-api-mcp", version: "0.1.0" },
    {
      instructions: `マネーフォワード クラウド会計の **APIキー認証版** MCPサーバーです。
公式beta MCPと同名のツール(mfc_ca_*)に加え、公式が提供しない証憑添付・添付解除・仕訳削除を提供します。

## OAuth版（mf-full）との違い

| | mf-full（OAuth） | このサーバー（APIキー） |
|---|---|---|
| 認証 | ブラウザで事業者を選んで許可 | **APIキー1本。ブラウザ不要** |
| 事業者の切替 | use_office（プロセス単位の状態） | **呼び出しごとに office_code。状態を持たない** |
| 認証情報の寿命 | refresh_token が使うたび変わる | **APIキーは変わらない** |
| 複数環境での併用 | **不可**（取り合いで invalid_grant になる） | **可**（同じキーを配ってよい） |
| **仕訳メモ欄** | **アプリ名が勝手に入る** | **何も入らない** |

## 認証
- APIキーは環境変数 MF_API_KEY か ~/.mf-api-key（600）に置く
- 発行: アプリポータル → APIキー管理 → **複数事業者タブ** → 新規登録
  - 利用可能サービス: **会計** と **事業者情報**
  - 利用可能事業者: **ページ送りがあるので全ページ選ぶこと**（1ページ分しか選ばれない事故が起きる）
- キーを編集しても**キーの値は変わらない**。顧問先が増えたらチェックを足すだけ

## 事業者の指定
- **すべてのツールが office_code を受け取る（XXXX-XXXX 形式）**
- list_offices で一覧を取得（MF から直接引くので自前の台帳は無い）
- MF_OFFICE_CODE を設定すると既定になる

## 注意
- ID は各 get 系ツールが返した URL エンコード済みの値をそのまま渡すこと
- 仕訳登録・更新・削除・証憑添付/解除・明細仕訳化は帳簿を書き換える。実行前にユーザーの承認を得ること
- putJournals は全置換 API。部分更新はできない
- 仕訳登録の body は journal_type が必須。科目は account_id（account_item_id ではない）。
  明細は debitor / creditor / remark の形（side/value ではない）
- getTransactions は start_date と end_date が必須
- invoice_kind は書き込み3値(QUALIFIED/NOT_TARGET/UNQUALIFIED_80)が公式仕様`,
    }
  );

  // ---- 認証・事業者 ----

  server.tool(
    "list_offices",
    "このAPIキーで使える事業者の一覧を表示する。MF から直接取得するので自前の台帳は無い。",
    { accounting_only: z.boolean().optional().describe("会計の権限があるものだけに絞る（既定: false）") },
    async ({ accounting_only }) => {
      try {
        const all = await listOffices();
        const list = accounting_only ? all.filter((o) => o.has_accounting) : all;
        return text({
          total: all.length,
          with_accounting: all.filter((o) => o.has_accounting).length,
          default_office_code: defaultOfficeCode() ?? null,
          offices: list.map((o) => ({
            office_code: o.office_code,
            name: o.name,
            has_accounting: o.has_accounting,
            roles: o.roles.length,
          })),
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "auth_status",
    "APIキーの状態を確認する（キーの所在・JWTの取得可否・使える事業者数）。キーの値は表示しない。",
    {},
    async () => {
      try {
        const key = readApiKey();
        await getJwt();
        const all = await listOffices();
        return text({
          api_key: `${key.slice(0, 11)}…（${key.length}文字）`,
          key_source: process.env.MF_API_KEY ? "環境変数 MF_API_KEY" : (process.env.MF_API_KEY_FILE ?? "~/.mf-api-key"),
          jwt: "取得できました（1時間有効・自動更新）",
          offices: all.length,
          with_accounting: all.filter((o) => o.has_accounting).length,
          default_office_code: defaultOfficeCode() ?? null,
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mf_api_info",
    "このサーバーの設定情報と、OAuth版（mf-full）との違いを表示する。",
    {},
    async () => {
      return text({
        server: "mf-api-mcp",
        auth: "APIキー（アプリの概念が無いので仕訳メモ欄にアプリ名が入らない）",
        api_base: "https://api-accounting.moneyforward.com/api/v3",
        exchange: "https://api.biz.moneyforward.com/auth/exchange",
        jwt_ttl: "1時間（自動更新）",
        rate_limit: "交換エンドポイントのみ APIキーごと毎分100回。429 は Retry-After 付き",
        office_code: "全ツールで必須（MF_OFFICE_CODE で既定化可）",
        env: {
          MF_API_KEY: process.env.MF_API_KEY ? "設定あり" : "未設定",
          MF_API_KEY_FILE: process.env.MF_API_KEY_FILE ?? "未設定（~/.mf-api-key を見る）",
          MF_OFFICE_CODE: process.env.MF_OFFICE_CODE ?? "未設定",
        },
      });
    }
  );

  // ---- 公式互換: 参照系 ----

  const availableParam = {
    ...officeParam,
    available: z
      .boolean()
      .optional()
      .describe("省略/true=有効のみ、false=全件（有効+無効）。falseは『無効のみ』ではない点に注意"),
  };

  server.tool("mfc_ca_currentOffice", "事業者情報と会計期間を取得します。", officeParam, async ({ office_code }) => {
    try {
      return text(await api("GET", "/offices", { officeCode: office_code }));
    } catch (e) {
      return errText(e);
    }
  });

  server.tool("mfc_ca_getTermSettings", "会計年度設定（税込/税抜・課税方式等）を取得します。", officeParam, async ({ office_code }) => {
    try {
      return text(await api("GET", "/term_settings", { officeCode: office_code }));
    } catch (e) {
      return errText(e);
    }
  });

  for (const [tool, path, desc] of [
    ["mfc_ca_getAccounts", "/accounts", "勘定科目を取得します。"],
    ["mfc_ca_getSubAccounts", "/sub_accounts", "補助科目を取得します。"],
    ["mfc_ca_getDepartments", "/departments", "部門を取得します。"],
    ["mfc_ca_getTaxes", "/taxes", "税区分を取得します。"],
    ["mfc_ca_getTradePartners", "/trade_partners", "取引先を取得します。"],
  ] as const) {
    server.tool(tool, desc, availableParam, async ({ available }) => {
      try {
        return text(await api("GET", path, { query: { available } }));
      } catch (e) {
        return errText(e);
      }
    });
  }

  server.tool(
    "mfc_ca_postTradePartners",
    "取引先を作成します。",
    { ...officeParam, trade_partner: z.record(z.any()).describe("取引先オブジェクト（code, name 等）") },
    async ({ trade_partner, office_code }) => {
      try {
        return text(await api("POST", "/trade_partners", { body: { trade_partner }, officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool("mfc_ca_getConnectedAccounts", "連携サービス（自動連携・手動管理とも）を取得します。", officeParam, async ({ office_code }) => {
    try {
      return text(await api("GET", "/connected_accounts", { officeCode: office_code }));
    } catch (e) {
      return errText(e);
    }
  });

  // ---- 公式互換: 仕訳 ----

  server.tool(
    "mfc_ca_getJournals",
    "仕訳一覧を取得します。start_date または end_date のいずれかが必要。",
    {
      ...officeParam,
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      account_id: z.string().optional(),
      is_realized: z.boolean().optional(),
      transaction_ids: z.array(z.string()).optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().optional().describe("最大10000"),
    },
    async (args) => {
      try {
        return text(await api("GET", "/journals", { query: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_getJournalById",
    "仕訳を1件取得します。",
    { ...officeParam, id: z.string().describe("仕訳ID（URLエンコード済みのまま）") },
    async ({ id, office_code }) => {
      try {
        return text(await api("GET", `/journals/${encodePathId(id)}`, { officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  const journalParam = {
    ...officeParam,
    journal: z
      .record(z.any())
      .describe(
        "仕訳オブジェクト { transaction_date, journal_type: 'journal_entry'|'adjusting_entry', branches: [{debitor?, creditor?, remark?}], tags?, memo? }。invoice_kind は自由値を許容（公式書込み3値以外は検証実験用）"
      ),
  };

  server.tool("mfc_ca_postJournals", "仕訳を作成します（帳簿書き込み。要ユーザー承認）。", journalParam, async ({ journal, office_code }) => {
    try {
      return text(await api("POST", "/journals", { body: { journal }, officeCode: office_code }));
    } catch (e) {
      return errText(e);
    }
  });

  server.tool(
    "mfc_ca_putJournals",
    "仕訳を更新します（全置換API・帳簿書き込み。要ユーザー承認）。",
    { ...officeParam, id: z.string(), ...journalParam },
    async ({ id, journal, office_code }) => {
      try {
        return text(await api("PUT", `/journals/${encodePathId(id)}`, { body: { journal }, officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_deleteJournals",
    "仕訳を完全削除します（公式MCP未提供・帳簿書き込み。要ユーザー承認）。",
    { ...officeParam, id: z.string() },
    async ({ id, office_code }) => {
      try {
        return text(await api("DELETE", `/journals/${encodePathId(id)}`, { officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 公式互換: 帳票 ----

  const trialParams = {
    ...officeParam,
    fiscal_year: z.number().int().optional(),
    start_month: z.number().int().optional().describe("カレンダー月"),
    end_month: z.number().int().optional().describe("カレンダー月"),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    with_sub_accounts: z.boolean().optional(),
    include_tax: z.boolean().optional(),
    journal_types: z.array(z.string()).optional(),
  };
  server.tool("mfc_ca_getReportsTrialBalanceBalanceSheet", "貸借対照表の試算表（累計）を取得します。", trialParams, async (args) => {
    try {
      return text(await api("GET", "/reports/trial_balance_bs", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });
  server.tool("mfc_ca_getReportsTrialBalanceProfitLoss", "損益計算書の試算表（累計）を取得します。", trialParams, async (args) => {
    try {
      return text(await api("GET", "/reports/trial_balance_pl", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });

  const transitionParams = {
    ...officeParam,
    type: z.string().describe("推移表の種類（例: monthly）"),
    fiscal_year: z.number().int().optional(),
    start_month: z.number().int().optional(),
    end_month: z.number().int().optional(),
    with_sub_accounts: z.boolean().optional(),
    include_tax: z.boolean().optional(),
  };
  server.tool("mfc_ca_getReportsTransitionBalanceSheet", "貸借対照表の推移表（月別）を取得します。", transitionParams, async (args) => {
    try {
      return text(await api("GET", "/reports/transition_bs", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });
  server.tool("mfc_ca_getReportsTransitionProfitLoss", "損益計算書の推移表（月別）を取得します。", transitionParams, async (args) => {
    try {
      return text(await api("GET", "/reports/transition_pl", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });

  // ---- 公式互換: 明細 ----

  server.tool(
    "mfc_ca_getTransactions",
    "連携サービスで収集された明細一覧を取得します（自動連携・手動とも）。",
    {
      ...officeParam,
      start_date: z.string().describe("YYYY-MM-DD。end_dateとの差366日以内"),
      end_date: z.string(),
      connected_account_id: z.string().optional(),
      connected_sub_account_id: z.string().optional(),
      journalizing_statuses: z
        .array(z.enum(["excluded", "none", "registered", "modified", "new_voucher_attached"]))
        .optional(),
      side: z.enum(["INCOME", "EXPENSE"]).optional(),
      value_min: z.number().int().optional(),
      value_max: z.number().int().optional(),
      content: z.string().optional(),
      content_match_type: z.enum(["exact", "partial", "forward", "backward"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().optional().describe("10〜1000"),
    },
    async (args) => {
      try {
        return text(await api("GET", "/transactions", { query: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_postTransactions",
    "手動管理の連携サービスに明細を作成します（要ユーザー承認）。",
    {
      ...officeParam,
      connected_account_id: z.string().describe("手動管理(is_manual: true)の連携サービスID"),
      transactions: z
        .array(
          z.object({
            date: z.string(),
            value: z.number().int(),
            side: z.enum(["INCOME", "EXPENSE"]),
            content: z.string(),
            memo: z.string().optional(),
          })
        )
        .min(1),
    },
    async ({ connected_account_id, transactions, office_code }) => {
      try {
        return text(await api("POST", "/transactions", { body: { connected_account_id, transactions }, officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_postTransactionJournalize",
    "明細から仕訳を作成します（帳簿書き込み。要ユーザー承認）。相手科目account_idのみ必須。貸借方向・口座側科目・税区分・invoice_kindはMFが自動補完。",
    {
      ...officeParam,
      transaction_id: z.string().describe("明細ID（URLエンコード済みのまま）"),
      account_id: z.string().describe("相手勘定科目ID"),
      sub_account_id: z.string().optional(),
      department_id: z.string().optional(),
      trade_partner_code: z.string().optional(),
      tax_id: z.string().optional(),
      invoice_kind: z.string().optional().describe("公式書込み3値以外も送信可（検証実験用）"),
      transaction_date: z.string().optional().describe("省略時は明細の取引日"),
      remark: z.string().optional(),
      memo: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        const { office_code: _oc, ...rest_ } = args;
        return text(await api("POST", "/transactions/journalize", { body: rest_, officeCode: _oc }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 公式未提供: 証憑 ----

  server.tool(
    "mfc_ca_postVouchers",
    "証憑をアップロードし仕訳に添付します（公式MCP未提供・要ユーザー承認）。file_paths を渡せばローカルファイルを自動でbase64化する。journal_id 省略時は孤立証憑になる（後から仕訳に紐づける手段はない）ので原則指定すること。",
    {
      ...officeParam,
      journal_id: z.string().optional().describe("添付先の仕訳ID"),
      file_paths: z.array(z.string()).optional().describe("ローカルファイルの絶対パス（file_name/file_dataは自動生成）"),
      voucher_files: z
        .array(z.object({ file_name: z.string(), file_data: z.string().describe("base64") }))
        .optional()
        .describe("base64を直接渡す場合"),
    },
    async ({ journal_id, file_paths, voucher_files, office_code }) => {
      try {
        const files = [
          ...(voucher_files ?? []),
          ...(file_paths ?? []).map((p) => ({
            file_name: basename(p),
            file_data: readFileSync(p).toString("base64"),
          })),
        ];
        if (files.length === 0) {
          return errText(new Error("file_paths か voucher_files のどちらかを指定してください"));
        }
        return text(await api("POST", "/vouchers", { body: { journal_id, voucher_files: files }, officeCode: office_code }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_deleteVouchers",
    "仕訳と証憑の紐付けを解除します（証憑自体は孤立して残る。公式MCP未提供・要ユーザー承認）。",
    {
      ...officeParam,
      journal_id: z.string(),
      voucher_file_id: z.string(),
    },
    async (args) => {
      try {
        const { office_code: _oc, ...rest_ } = args;
        return text(await api("DELETE", "/vouchers", { body: rest_, officeCode: _oc }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 情報 ----

  
  return server;
}

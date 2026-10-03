import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { api, encodePathId, defaultOfficeCode } from "./rest.js";
import { listOffices, getJwt, readApiKey } from "./apikey.js";
import { registerBoxTools } from "./box-tools.js";
import { registerBookkeepingTools } from "./bookkeeping-tools.js";

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

/** 会計 API を呼ぶツール共通。APIキー認証では事業者番号が必須。 */
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
| 同じ人の複数環境での併用 | 同じ認証ファイルをコピーすると更新が競合する。認証を1台へ集約するか端末ごとに別アプリで認可する | **可**（他の人にはキーを渡さない） |
| **仕訳メモ欄** | **アプリ名が勝手に入る** | **何も入らない** |

## 認証
- APIキーは環境変数 MF_API_KEY か ~/.mf-api-key（600）に置く
- 発行: アプリポータル → APIキー管理 → **複数事業者タブ** → 新規登録
  - 利用可能サービス: **会計** と **事業者情報**
  - 利用可能事業者: **ページ送りがあるので全ページ選ぶこと**（1ページ分しか選ばれない事故が起きる）
- キーを編集しても**キーの値は変わらない**。顧問先が増えたらチェックを足すだけ

## 事業者の指定
- **会計 API を呼ぶ mfc_ca_* ツールが office_code を受け取る（XXXX-XXXX 形式）**
- list_offices で一覧を取得（MF から直接引くので自前の台帳は無い）
- MF_OFFICE_CODE を設定すると既定になる

## クラウドBox
- 保存方式は対象事業者についてユーザーが選んだ運用とMFスキルに従う。2件保存＋メモURL方式は、mfc_box_uploadFileで取得用原本を保存し、同じ原本をmfc_ca_postVouchersで新規保存・仕訳添付する
- 2件保存方式では取得用の通常URL https://box.moneyforward.com/files/{file_id} を仕訳メモmemoへ追記する。摘要remarkは変更しない。既存メモを保持し、同じURLを重複追加しない。メモ上限200文字に収まらない場合は既存内容を勝手に削らない
- 取得用file_idと添付用voucher_file_idは別ID。仕訳GETで添付用IDを確認し、GETしたメモURLから取得用IDを取り出してdownloadFileで原本とのSHA-256一致を確認する。2件保存とメモ更新を組み合わせた運用は実行ごとに一連の検証を行う
- メモ更新のputJournalsは全置換。会計内容・税額・タグ・既存添付・transaction_idを保持し、更新後GETで確認する。通常URLを記録し、共有リンクや署名付きダウンロードURLは記録しない
- mfc_ca_postVouchers由来の本体はBox APIで取得を拒否された実測がある。添付用IDのURLをメモに書くだけでは取得できるようにならない
- 添付済み証憑の取得は、対象事業者を指定して仕訳GET → voucher_file_idsの各ID → mfc_box_fileUrls → web_download_urlをアクセス権のあるログイン済みブラウザで取得 → 原本がある場合はSHA-256照合。ID自体は推測せずAPIの実データを使う
- ブラウザ用原本URLは https://box.moneyforward.com/frontend/v3/files/{file_id}/download。Box APIで403 INTERNAL_FILE_ACCESS_NOT_ALLOWEDだった会計API添付1件を、このブラウザ経路で取得して原本一致を実測した。同じIDをCookieなし・OAuth Bearerのみで取得すると401、認証なしも401。同じOAuthトークンの公開API情報取得は200で、有効なOAuthだけでは今回のブラウザログインを代替できなかった。全ファイル種別は未検証。画面用URL変更時は現行ダウンロードリンクを確認し、署名付き転送先URLやブラウザ認証情報を保存しない
- 添付済み原本を再送しない。結果不明時は仕訳GETと保存記録を照合してから再実行を判断する
- Box APIの通信には別途OAuth接続が必要。会計のAPIキーとは分離している。mfc_box_fileUrlsはURL生成だけで通信・OAuth認証・本体取得を行わない
- 保存済み認証は自動更新する。同じ認証を複数のMacへコピーしない
- 認証を持つMacにMCPを集約し、他端末からSSHで利用できる。同一Mac内の更新は直列化する
- getFiles/getFile/uploadFile/downloadFile/authStatus/fileUrlsを提供。ローカルパスはMCPホスト上のパス
- Box APIで保存したファイルは仕訳への添付後も取得できることを実測確認済み
- MF内部システム由来の既存ファイルは本体取得が拒否される場合がある
- uploadFileはBox保存のみ。保存済みファイル1件をそのまま仕訳へ紐づける代替経路はMF画面の「クラウドBoxから選択」。この経路ではfile_idとvoucher_file_idが一致する
- 取得用と添付用の各ID、仕訳ID、メモURL、原本SHA-256、処理段階を記録し、未完了分を区別する。既存添付の一括変更や別事業者への方針適用はしない
- 取引情報・電帳法区分の設定はこのBoxツールに含まれない

## 注意
- ID は各 get 系ツールが返した URL エンコード済みの値をそのまま渡すこと
- 仕訳登録・更新・削除・証憑添付/解除・明細仕訳化は帳簿を書き換える。実行前にユーザーの承認を得ること
- putJournals は全置換 API。部分更新はできない
- 仕訳登録の body は journal_type が必須。科目は account_id（account_item_id ではない）。
  明細は debitor / creditor / remark の形（side/value ではない）
- getTransactions は start_date と end_date が必須
- invoice_kind は INVOICE_KIND_QUALIFIED / INVOICE_KIND_NOT_TARGET / INVOICE_KIND_UNQUALIFIED_80 のように INVOICE_KIND_ 接頭辞付きで送る。短い値は400になった（APIキー経路で実測）
- TAX_INCLUDEDの仕訳書込みではvalueに税込額を送る。GETではvalueは税抜、税込額はvalue+tax_value。書込み直後のレスポンスだけで金額を検証せずGETで確認する
- getTransactionsのper_pageは最大500`,
    }
  );

  registerBoxTools(server);
  registerBookkeepingTools(server);

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
        readApiKey();
        await getJwt();
        const all = await listOffices();
        return text({
          api_key: "設定あり（値は表示しません）",
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
        cloudbox: { api_base: "https://api.box.moneyforward.com/v1/files", auth: "事業者ごとのOAuth（自動更新・ホスト固定・更新の排他制御）", config: process.env.MF_BOX_CONFIG ?? "~/.mf-api-mcp/cloudbox.json" },
        exchange: "https://api.biz.moneyforward.com/auth/exchange",
        jwt_ttl: "1時間（自動更新）",
        rate_limit: "交換エンドポイントのみ APIキーごと毎分100回。429 は Retry-After 付き",
        office_code: "mfc_ca_* ツールで必須（MF_OFFICE_CODE で既定化可）",
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
    server.tool(tool, desc, availableParam, async ({ available, office_code }) => {
      try {
        return text(await api("GET", path, { query: { available }, officeCode: office_code }));
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
    "仕訳一覧を取得します。start_date または end_date のいずれかが必要。添付証憑IDはvoucher_file_ids。各IDをmfc_box_fileUrlsへ渡すとブラウザ用取得URLを生成できます。本体取得には権限のあるログイン済みブラウザを使います。",
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
    "仕訳を1件取得します。添付証憑IDはjournal.voucher_file_ids。各IDをmfc_box_fileUrlsへ渡し、web_download_urlを権限のあるログイン済みブラウザで取得できます。Box OAuth APIの取得可否とは別です。",
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
        "仕訳オブジェクト { transaction_date, journal_type: 'journal_entry'|'adjusting_entry', branches: [{debitor?, creditor?, remark?}], tags?, memo? }。税込経理ではvalueに税込額を指定。invoice_kindはINVOICE_KIND_接頭辞付きの値を指定する"
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
      per_page: z.number().int().max(500).optional().describe("最大500"),
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
      invoice_kind: z.string().optional().describe("INVOICE_KIND_QUALIFIED / INVOICE_KIND_NOT_TARGET等、INVOICE_KIND_接頭辞付きの値"),
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
    "会計APIで証憑を新規保存し、journal_idを指定すると仕訳へ同時添付します。保存先はクラウドBoxでブラウザ操作は不要。ただし会計API由来の本体はBox APIから取得を拒否された実測があります。ユーザーが2件保存＋メモURL方式を選んだ場合は、同じ原本をBox APIで取得用として別途保存・取得確認し、その通常URLを仕訳メモmemoに残します。取得用IDとこのツールの添付用IDは別です。file_pathsは自動でbase64化。返却file_idを仕訳GETで照合し、原本とID対応を保持します。既存BoxファイルIDの再利用には対応しません。添付済み原本を再送しないでください。",
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

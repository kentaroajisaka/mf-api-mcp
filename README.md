# mf-api-mcp

マネーフォワード クラウド会計の **APIキー認証版** MCPサーバー。

[mf-full-mcp](https://github.com/kentaroajisaka/mf-full-mcp)（OAuth版）と同じツールを提供しつつ、
2026-09-24 に MF が公開した **APIキー認証**を使う。

## ⚠️ APIキーは配らないこと

**APIキー＝発行者そのもの。** JWT に発行者の `mfid_uid` と、事業者ごとの `tenant_user_uid`
が入る。公式ドキュメントも「**発行したユーザーに付与されている権限で**APIを実行する」と明記。

キーを渡した相手は、**自分では入れない事業者にも発行者の権限で書き込める。** 画面の権限制御は通らない。

**しかも誰がやったか帳簿に残らない可能性が高い。** このサーバーで仕訳を1件作って
MF形式CSVに落としたところ、こうなっていた:

```
MF仕訳タイプ : 外部連携（API）
作成者       : システムユーザー      ← 発行者の名前は出ない
最終更新者   : システムユーザー
```

**1件しか確認していないので断定はしない**が、そうだとすると誰が API を叩いたか
帳簿から追えない。API のレスポンスにも作成者のフィールドは無い（`entered_by` は
`JOURNAL_TYPE_EXTERNAL` / `JOURNAL_TYPE_IMPORT` 等の**経路**を表すもので、人ではない）。

**各自が自分のアカウントで自分のキーを発行すること。** 権限が自動で本人の範囲に絞られ、
退職時はそのキーだけ消せる。職員向けのボットに持たせる場合も同じ問題が起きる
（職員がボットに頼めば発行者の権限で実行される）。

## OAuth版（mf-full）との違い

| | mf-full（OAuth） | **mf-api（APIキー）** |
|---|---|---|
| 認証 | ブラウザで事業者を選んで許可 | **APIキー1本。ブラウザ不要** |
| 事業者の切替 | `use_office`（プロセス単位の状態） | **呼び出しごとに `office_code`。状態を持たない** |
| 認証情報の寿命 | `refresh_token` が使うたび変わる | **APIキーは変わらない** |
| 同じ人の複数環境での併用 | **不可**（取り合いで `invalid_grant`） | **可**（キーの値が変わらないため） |
| 事業者の台帳 | 自前で `tokens.json` を持つ | **MF から引く。台帳不要** |
| **仕訳のメモ欄** | **アプリ名が勝手に入る** | **何も入らない** |

最後の行が実務では大きい。OAuth には「アプリ」が存在する（アプリポータルで名前を付けて登録する）
ので MF がその名前を記録でき、それが仕訳のメモ欄に出ていた。**APIキーには「アプリ」が無い**
ので、書き込む名前が存在しない。メモ欄を自分の用途に使える。

## APIキーの発行

アプリポータル → APIキー管理 → **「複数事業者」タブ** → 新規登録

- **利用可能サービス**: 会計 と 事業者情報
- **利用可能事業者**: **ページ送りがある。全ページ選ぶこと**
  （全選択したつもりが1ページ分しか入っておらず、普段使っている事業者の大半が漏れていた。
   気づいたのは API が「その事業者は使えない」と返したとき）

**キーは一度しか表示されない。** ただし**編集してもキーの値は変わらない**ので、
顧問先が増えたらチェックを足して保存するだけでよい。配り直しは不要。

## 設定

キーの置き場（優先順）:

1. 環境変数 `MF_API_KEY`
2. `MF_API_KEY_FILE` が指すファイル
3. `~/.mf-api-key`（600）

```json
{
  "mcpServers": {
    "mf-api": {
      "command": "node",
      "args": ["/path/to/mf-api-mcp/dist/index.js"],
      "env": { "MF_OFFICE_CODE": "XXXX-XXXX" }
    }
  }
}
```

`MF_OFFICE_CODE` は既定の事業者。省略すると全ツールで `office_code` が必須になる。

## 仕組み

```
APIキー（期限なし） → POST https://api.biz.moneyforward.com/auth/exchange
                    → JWT（ES256・1時間。1分前まで使い回す）
                    → https://api-accounting.moneyforward.com/api/v3/...
```

- 交換エンドポイントのレート制限は **APIキーごと毎分100回**。1時間に1回しか叩かないので当たらない。
  429 は `Retry-After` 付きで返る
- **`office_code` は必須**。無いと `400 missing_required_query_parameter`。
  OAuth では無視されるパラメータ

## ツール

`mfc_ca_*` は公式beta MCPと同名。**すべて `office_code` を受け取る。**

| 種別 | ツール |
|---|---|
| 認証・事業者 | `list_offices` `auth_status` `mf_api_info` |
| 参照 | `mfc_ca_currentOffice` `getTermSettings` `getAccounts` `getSubAccounts` `getDepartments` `getTaxes` `getTradePartners` `getConnectedAccounts` |
| 仕訳 | `getJournals` `getJournalById` `postJournals` `putJournals` **`deleteJournals`** |
| 帳票 | `getReportsTrialBalance{BS,PL}` `getReportsTransition{BS,PL}` |
| 明細 | `getTransactions` `postTransactions` `postTransactionJournalize` |
| **証憑** | **`postVouchers`** **`deleteVouchers`** |

太字は**公式MCPのツール一覧に無い**もの（公式MCP自体は試していない。
REST API 側にエンドポイントが存在するかは別問題で、実際このサーバーは REST で叩いている）。
証憑添付が要る用途では公式MCPに乗り換えられない。

## 実測メモ（2026-09-25・検証用の事業者で確認）

登録時の body でここを間違えて 400 を3回踏んだ。

- `journal_type` が**必須**
- 科目は `account_item_id` ではなく **`account_id`**
- 明細は `side`/`value` ではなく **`debitor` / `creditor` / `remark`**
- `getTransactions` は **`start_date` と `end_date` が必須**
- 試算表は `from`/`to` ではなく **`fiscal_year`**
- メモに文字を入れると**末尾に `\n` が付く**。空なら空のまま

ID の `%2F` 問題（Base64 の ID をパスに埋めると 403 になる）は OAuth 版と同じ。
`encodePathId` が処理する。

## ライセンス

MIT

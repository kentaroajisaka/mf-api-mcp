# mf-api-mcp

マネーフォワード クラウド会計の **APIキー認証版** MCPサーバー。クラウドBoxには別途OAuthで接続します。

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
| 同じ人の複数環境での併用 | 同じ認証をコピーすると更新が競合。認証の集約、または端末別アプリで認可すれば回避可能 | **可**（キーの値が変わらないため） |
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

`MF_OFFICE_CODE` は会計 API を呼ぶ `mfc_ca_*` ツールの既定の事業者。未設定なら呼び出しごとに `office_code` を渡す。
引数の `office_code` は `MF_OFFICE_CODE` より優先される。認証・情報表示の3ツールは事業者番号を受け取らない。

## 証憑の保存・添付・本体取得

APIからの原本再取得と仕訳への添付を両立する方式として、**API取得用原本と仕訳添付用を別々に保存し、取得用原本の通常URLを仕訳メモに残す**手順を利用できます。適用する事業者・範囲・保存方式は利用者の依頼で確認します。

1. `mfc_box_uploadFile` で取得用原本を保存し、`mfc_box_downloadFile` で元ファイルとのSHA-256一致を確認する。
2. 取得用IDの `https://box.moneyforward.com/files/{file_id}` を `journal.memo` に追記する。摘要 `branches[].remark` は変更しない。既存メモを保持し、同一URLは重複追加しない。
3. 同じ原本を `mfc_ca_postVouchers(office_code, journal_id, file_paths)` で添付用として新規保存・添付し、仕訳GETで返却された添付用IDを確認する。
4. 仕訳GETのメモURLから取得用IDを取り出し、Box APIで本体を取得・原本照合する。

**取得用と添付用は同内容の2ファイルで、IDも別。** 上記は既存ツールを組み合わせる手順であり、ツール1回でメモ追記まで自動実行する機能ではありません。実行ごとに、仕訳GET・メモURLからの原本再取得・SHA-256一致まで確認します。
メモ上限は公開仕様で200文字。上限を超える場合は既存内容を勝手に削らず、該当分を例外として扱う。既存仕訳のメモ追記には全置換の `putJournals` が必要なので、会計内容・税額・タグ・既存添付・連携明細IDを保持し、保存後GETで照合する。共有リンクや署名付きダウンロードURLはメモに残さない。

保存済みBoxファイル1件をそのまま添付する代替経路は、MF画面の「クラウドBoxから選択」。こちらはBoxの保存IDと添付IDが一致する。
1仕訳の添付は最大5件、会計APIでは1ファイル最大5MB。既存の添付を含めて上限を確認する。

会計APIで保存したファイルは、Box APIによる本体取得が拒否された実測がある。
原本と元証憑ID・SHA-256・仕訳ID・取得用ID・添付用ID・メモURL・検証結果の対応を保持し、添付の成功とAPI再取得可否を区別する。利用者が参照する対応付けはMF仕訳メモに置き、ローカル記録は再実行・復旧用の補助とする。
添付済み原本を方式変更だけで再送しない。応答不明時も仕訳GETと保存記録を照合してから再実行を判断する。

## クラウドBox API（OAuth）

2件保存方式では取得用IDと添付用IDを区別する。Box APIで保存した1件を画面で直接添付する場合だけ、保存済みのBoxファイルIDと仕訳の添付IDを一致照合する。

会計のAPIキーはそのまま使い、Boxだけ事業者ごとのOAuth接続を設定する。
必要なスコープは `mfc/box/files.read`、保存には追加で `mfc/box/files.write`。
OAuthだから毎回ログインするわけではない。期限切れは保存済みrefresh tokenで自動更新する。
解除・失効・更新情報を失った場合は再認可が必要。

### 認証を1台へ集約する

Mac mini上に認証とMCPを置き、MacBookからはSSH経由で同じMCPを起動する構成に対応。
複数のMCPプロセスが起動しても、トークンファイル横のロックで更新を直列化し、
ロック取得後に最新のトークンを読み直す。認証情報をMacBookにコピーしない。
Mac miniへの接続が必要になり、ツールの入出力パスもMac mini上のパスになる。

```json
{
  "mcpServers": {
    "mf-api": {
      "command": "/usr/bin/ssh",
      "args": [
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "YOUR-USER@YOUR-MAC-MINI-TAILSCALE-NAME",
        "/path/to/node", "/path/to/mf-api-mcp/dist/index.js"
      ]
    }
  }
}
```

SSHのホスト鍵確認と鍵認証は事前に設定する。MCP用のHTTPポートを外部公開する必要はない。
MacBook単独で利用する場合は、**別のOAuthアプリ（client_id）を作り、その端末で認可する**。
同じrefresh tokenを同期・コピーしない。リポジトリの同期と認証情報の同期を分ける。

### 接続設定

`~/.mf-api-mcp/cloudbox.json`（権限600、親ディレクトリ700）に設定する。
`MF_BOX_CONFIG` で別パスを指定可能。秘密そのものはここに書かず、既存の認証ファイルを参照する。

```json
{
  "version": 1,
  "connections": {
    "1234-5678": {
      "office_name": "接続先事業者名",
      "tenant_uid": "123456",
      "owner_host": "YOUR-AUTH-HOST.local",
      "token_file": "/Users/you/.mf-cloudbox/token.json",
      "verification_file_id": "00000000-0000-4000-8000-000000000001"
    }
  }
}
```

`tenant_uid` はBox APIが返した事業者ID、`verification_file_id` はその事業者の既存ファイルID。
MF画面で事業者名と事業者番号を確認してから登録する。書き込み前にはそのファイルの事業者IDを
APIで再照合する。この確認用ファイルが削除されたら、同じ事業者の別ファイルへ設定を更新する。
別事業者・別ホストへ自動的に切り替えることはない。

認証ファイルは権限600で、以下のフィールドを持つ公開クライアント（PKCE、認証方式none）のものを使用する。
ブラウザ認可・アプリの新規登録はこのMCPのツールには含めていない。

```text
clientId, scope, accessToken, refreshToken, expiresAt（UNIXミリ秒）, authorizedAt（任意）
```

認証を参照する他のプログラムも更新する場合は、同じ排他制御に統一すること。
更新中にプロセスが強制終了して `.refresh.lock` が残った場合は、ファイル内のPIDが停止していることを
確認してからロックを解除する。タイムアウトだけを根拠に稼働中のロックを自動削除しない。

### Boxツール

API通信を行うツールは `office_code` を受け取り、`MF_OFFICE_CODE` を既定値として使います。通信なしのURL生成ツール `mfc_box_fileUrls` はファイルIDだけを受け取ります。

| ツール | 内容 |
|---|---|
| `mfc_box_authStatus` | 接続先・権限・自動更新。`verify: true` でAPI疎通と事業者を確認 |
| `mfc_box_getFiles` | 一覧。続きは `pagination.next_page` を `page` に渡す |
| `mfc_box_getFile` | `file_id` の情報を取得 |
| `mfc_box_uploadFile` | MCPホストの `local_path` を保存。任意の `file_name` / `mime_type` |
| `mfc_box_downloadFile` | `file_id` の本体を `output_path` に保存しSHA-256を返す。上書きしない |
| `mfc_box_fileUrls` | 添付ファイルIDから詳細画面・ブラウザ用・API用URLを生成。通信・OAuth認証・本体取得なし |

アップロード・ダウンロードはMCP側で50MiBまでに制限。取引情報・電帳法区分は設定しない。
保存は自動再送しない。通信結果が不明なときは一覧で照合してから再実行する。
ダウンロードの署名URLは結果へ出さず、転送先へMFのBearerトークンを送信しない。

**Box APIによる保存と、保存済みファイルの仕訳への紐づけは別の操作。** 既存Boxファイルを再利用する紐づけは、公開会計APIにはなくMF画面の「クラウドBoxから選択」で行う。
会計の `postVouchers` は新規アップロードと添付を同時にできるが、Box APIによる本体取得を保証するものではない。

2026-10-03の実測では、Box APIで保存したPDFは仕訳添付後も別の読み取り専用OAuthアプリから取得できた。
一方、会計APIやBox画面で保存した既存ファイルでは `INTERNAL_FILE_ACCESS_NOT_ALLOWED` となった。
すべての既存ファイルをAPIでダウンロードできるわけではない。

添付済み証憑にはブラウザで取得できる経路もあります。対象事業者を指定して `mfc_ca_getJournalById` → `journal.voucher_file_ids` → `mfc_box_fileUrls({file_id})` → 返る `web_download_url` をアクセス権のあるログイン済みブラウザで取得、の順に使います。ファイルIDは推測せず仕訳APIから取得します。URL生成ツールは通信・OAuth認証・本体取得を行いません。

ブラウザ用URLは `https://box.moneyforward.com/frontend/v3/files/{file_id}/download`。2026-10-04に画面の実際のダウンロードリンクを確認し、Box OAuth APIで403となった会計API添付PDF1件をこの経路で取得、原本とのSHA-256一致を確認しました。同じIDでCookieなし・OAuth Bearerのみの画面用URL取得は401、認証なしも401でした。同じOAuthトークンの公開API情報取得は200で事業者・ファイルも一致し、トークンは有効でした。今回、OAuthだけでブラウザログインを代替できませんでした。画面用URLは公開API仕様ではなく、全ファイル種別を検証したものではありません。変更された場合は現行の詳細画面のリンクを確認し、一時的な署名付き転送先URLは保存しません。新規証憑の保存方式はユーザーが選んだ運用を維持します。

参考: [OAuth認可・有効期限](https://developers.biz.moneyforward.com/docs/common/oauth/overview/)、
[トークン更新](https://developers.biz.moneyforward.com/docs/api/auth/create-token/)。

## 経理の一括取得・照合・処理後確認

`mf_bookkeeping_scan` / `mf_bookkeeping_reconcile` / `mf_bookkeeping_verify` / `mf_bookkeeping_departments` と、同じ処理を呼ぶ `dist/bookkeeping-cli.js` を提供します。事業者・年度・期間は引数、科目はAPI、個別の対応指定は外部JSONから取得します。未仕訳0件は最小取得で終了し、照合や再判定は取得済みデータを再利用します。部門別確認を指定した取得では未仕訳0件でも年度仕訳を取得します。部門のある事業者の処理後確認は、全社残高と部門別増減を比較します。

読み取り専用です。候補レポート、借方・貸方・摘要・証憑ID、処理前後の残高差分をまとめます。[実行方法と設定形式](docs/bookkeeping-batches.md)を参照してください。既存MCPプロセスが新ツールをまだ公開していない場合もCLIを使用できます。

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

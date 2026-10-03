# 経理の一括取得・照合・処理後確認

毎回の一時スクリプトを作らず、同じ CLI / MCP を使う。事業者、年度、期間、科目、補助科目、対応先 ID、個別の表記差はソースに埋め込まない。実行引数、MF の現行設定・マスター、事業者を明示した外部 JSON から渡す。API のページ上限などの仕様定数とは区別する。

このバッチは読み取り専用。仕訳の登録・更新、証憑保存、対象外変更そのものは既存の API / 画面経路を使う。給与登録には MF 標準連携画面を利用できる。このバッチは給与の確定・再計算・振込を行わない。

## 共通の入口

ビルド済みの `dist/bookkeeping-cli.js` を、認証があるホスト上の Node で起動する。MCP を使えない実行環境でも同じコードを使える。認証情報は既存 `mf-api` と共通で、CLI 引数・設定 JSON に書かない。

```bash
node "$MF_BATCH_ROOT/dist/bookkeeping-cli.js" scan \
  --office "$BOOKKEEPING_OFFICE" --fiscal-year "$BOOKKEEPING_YEAR" \
  --end "$BOOKKEEPING_END" --output-dir "$BOOKKEEPING_OUTPUT"
```

変数は対象事業者と依頼期間を確認して呼出側で設定する。`MF_BATCH_ROOT` はこのリポジトリの実際の配置先。`--start` 省略時は、指定年度の開始日を MF API から取得する。月日や暦年を推測しない。パスはすべて実行ホスト上の絶対パス。

MCP の同等ツール:

| ツール | 用途 | 主な引数 |
| --- | --- | --- |
| `mf_bookkeeping_scan` | API 一括取得と照合 | `office_code`, `fiscal_year`, `end_date`, `output_dir`, 任意 `start_date`, `audit_links`, `department_balances`, `config_file` |
| `mf_bookkeeping_reconcile` | 保存済みデータで再照合 | `snapshot_file`, `output_dir`, 任意 `config_file` |
| `mf_bookkeeping_verify` | 対象仕訳と明細状態、残高差分の確認 | `snapshot_file`, `manifest_file`, `output_dir` |
| `mf_bookkeeping_departments` | 保存済み年度仕訳から部門別集計 | `snapshot_file`, `output_dir`, 任意 `opening_file` |

MCP ツール一覧はサーバー起動時に読み込まれる。既に動いている接続に新ツールが見えない間は CLI を使う。他の作業を止めるための再起動はしない。各MCPクライアントが同じホストへアクセスできることと、その環境で実操作まで検証済みであることは別に記録する。

## 処理の流れ

1. `scan` で未仕訳を先に取得する。0 件なら年度設定と未仕訳の 2 会計 API 呼出で終了し、全仕訳を再取得しない。登録済み明細も調べる場合や、処理前残高の基準が必要なら `--audit-links` を付ける。部門別基準も必要なら `--department-balances` を指定する。この指定でも0件の最小取得を解除する。
2. 未仕訳があれば、年度仕訳は `per_page=10000`、明細は `500`。追加ページは metadata に従う。科目・補助科目・税区分・部門・口座設定と BS/PL も一度取得し、独立した取得を並行する。科目APIに補助科目一覧が含まれている場合はそれを使い、補助科目APIを重複取得しない。取得中の件数変化、重複 ID、ページ欠落を検出したら途中データで判定しない。
3. `snapshot.json` を作業中の基準にする。設定を変えて再照合するだけなら `reconcile` を使い、API を取り直さない。取得時刻を保持する。別セッションの更新が疑われる場合は対象だけ再取得する。
4. 日付、入出金方向、税込額、決済科目・補助科目、内容が一致し、双方から一意なものを `matched_candidate` にする。GET の税込額は `value + tax_value`。別カード、登録済み明細に対応する仕訳、同額複数候補、同じ仕訳の取り合いは `review` に残す。複数仕訳への合算や源泉控除は自動確定せず、個別に確認する。
5. 明細 `none` と登録済み明細の問題を分ける。`linked_issues` は登録済み側の監査結果で、未仕訳件数ではない。レポートには元明細・連携サービス・利用者または口座・取引 No・借方・貸方・税込額・摘要・証憑 ID を残す。
6. 証憑 ID は添付有無の情報に過ぎない。内容が同じかは原本で確認する。MF に添付がないことだけで、freee のファイルボックス等にも領収書がないと判断しない。有効なUUIDの添付IDには `voucher_urls`、仕訳メモのCloudBox通常URLには `memo_evidence_urls` を出力する。詳細画面、ログイン済みブラウザ用ダウンロード、OAuth API用ダウンロードのURLを分ける。URL生成はアクセス成功の検証ではない。証憑ダウンロード・OCR はこのバッチに含まない。
7. 承認済みの処理範囲で候補を確認し、書込直前に対象仕訳と明細の現在状態を既存 API で確認する。対象外変更は既存の画面一括操作。候補レポートだけを自動実行の許可と扱わない。結果不明時は現状を読み直し、登録やアップロードを重ねない。
8. `verify` で対象仕訳だけ GET し、明細状態と BS/PL を一括確認する。未仕訳件数は指定期間全体を確認し、対象IDの状態照合は対象明細の日付範囲だけ取得する。対象明細がなければ登録済み明細の再取得を省く。勘定科目・補助科目ごとの数値差分を許可した仕訳の増減と比較する。帳簿不変と銀行の実残高一致を混同しない。Notion の手順・実行記録更新は最後にまとめる。

## 個別設定は外部 JSON

通常は連携口座の `account_id` / `sub_account_id` をそのまま使う。freee 移行後の実科目が連携設定と異なる場合だけ `bindings` を明示する。API が返したエンコード済み ID をそのまま渡す。名前指定はマスターで一意に一致する場合だけ受け付ける。

以下は形を示すテンプレート。プレースホルダーを現在の API 取得値と確認済み判断で置き換える。実際の事業者設定・例外は私有フォルダに保存し、共通ソースへ追記しない。

```json
{
  "office_code": "<対象事業者>",
  "bindings": [
    {
      "connected_account_id": "<連携サービスID>",
      "connected_sub_account_id": "<カード・口座ID。ない場合null>",
      "account": { "name": "<帳簿上の決済科目名>" },
      "sub_account": { "name": "<補助科目名>" },
      "reason": "<移行後の科目を確認した根拠>"
    }
  ],
  "content_aliases": [
    {
      "connected_account_id": "<連携サービスID>",
      "connected_sub_account_id": "<カード・口座ID。ない場合null>",
      "transaction_content": "<明細の内容全文>",
      "journal_remark": "<確認した仕訳摘要全文>",
      "reason": "<同一取引先の表記差と確認した根拠>"
    }
  ]
}
```

補助科目なしは `sub_account: null`。ID 指定なら `{ "id": "<ID>" }`。`name` と `id` の両方は指定しない。設定は `--config` / `config_file` で渡す。金額一致だけの手動例外、仕訳番号別の分岐、広い正規表現、あいまいな部分一致をソースに加えない。

```bash
node "$MF_BATCH_ROOT/dist/bookkeeping-cli.js" reconcile \
  --snapshot "$BOOKKEEPING_SNAPSHOT" --config "$BOOKKEEPING_CONFIG" \
  --output-dir "$BOOKKEEPING_OUTPUT"
```

## 処理後確認の対象

`candidate_verification_manifest.json` は、候補をすべて確認して対象外にした場合の確認用入力。保留明細は `none` のままという期待も含む。実際の承認範囲が異なる場合は、その範囲に合わせて外部 JSON を作る。生成された期待値は書込指示ではない。

```json
{
  "office_code": "<対象事業者>",
  "journal_ids": ["<処理前スナップショットにある対象仕訳ID>"],
  "expected_statuses": [
    { "transaction_id": "<対象明細ID>", "status": "excluded" }
  ]
}
```

```bash
node "$MF_BATCH_ROOT/dist/bookkeeping-cli.js" verify \
  --snapshot "$BOOKKEEPING_SNAPSHOT" --manifest "$BOOKKEEPING_MANIFEST" \
  --output-dir "$BOOKKEEPING_OUTPUT"
```

この確認は、既存仕訳の変更や対象外操作の前後比較に使う。基準に存在しない新規仕訳の確認は既存の仕訳 GET と残高 API で行う。`verify` は変更内容が会計的に正しいかを自動決定しない。

## 部門別の確認

試算表APIは全部門合計。全社残高だけの比較では部門の付け替えを検出できない。年度仕訳を借方・貸方それぞれの `department_id`、科目ID、補助科目IDで集計する。部門未設定も1区分として含める。表示名と親部門IDは取得済みマスターから読む。親部門への直接計上と子部門の直接計上は別行のままにし、合計を二重加算しない。

`scan --department-balances` では処理前の `department_balances.json` も保存する。再集計のみなら次のCLIまたは `mf_bookkeeping_departments` を使い、APIを呼ばない。

```bash
node "$MF_BATCH_ROOT/dist/bookkeeping-cli.js" departments \
  --snapshot "$BOOKKEEPING_SNAPSHOT" --output-dir "$BOOKKEEPING_OUTPUT"
```

対象期間はMFの実際の年度開始日からスナップショットの終了日まで。月次増減が必要なら同じ年度の前月末・当月末の累計差分を比較する。暦年の1月始まりを仮定しない。税込経理は `value + tax_value`、対応する税抜方式は `value`。未知の方式は停止する。未実現仕訳は除外し、実現状態・部門IDが不明なら検証を完了しない。

`verify` は処理前データに部門マスターまたは部門付き仕訳がある場合、部門別比較も既定で実行する。対象仕訳のGETに加え、年度仕訳を `per_page=10000` で一括再取得し、同じマスター・金額基準で科目補助科目別の増減差分を比較する。必要な場合はmanifestで `department_balances: true` を明示できる。省略する判断をした場合だけ `false` を指定し、部門確認省略を報告する。結果の `department_balances_checked`、`department_balances_unchanged`、`department_balance_changes` と差分明細を確認する。変更がある場合は許可した仕訳の部門・金額と照合する。差分0の自動判定と、変更内容の妥当性確認は別。

部門別の期首残高なしでは、期中借方・貸方・純増減を確認する。期末絶対残高はnullにし、全社期首残高を部門に割り振ったり未指定行を0とみなしたりしない。確定した期首残高がある場合は `--opening` / MCP `opening_file` に外部JSONを渡す。verifyではmanifestの `department_opening` に同じオブジェクトを入れる。

```json
{
  "office_code": "<対象事業者>",
  "fiscal_year": 0,
  "as_of_date": "<MF年度開始日の前日 YYYY-MM-DD>",
  "basis": "gross",
  "source": "<部門別期首残高の確認済み出典>",
  "rows": [{
    "department_id": "<MF部門ID。未設定はnull>",
    "account_id": "<MF科目ID>",
    "sub_account_id": null,
    "opening_debit_minus_credit": 0
  }]
}
```

数値0も形のプレースホルダーで、実年度・確認済み金額へ置き換える。税抜では `basis: "net"`。期首は借方残を正、貸方残を負として渡す。事業者・年度・日付・金額基準が違う入力や重複キーを拒否する。明示した行だけ期末残高を計算する。`closing_debit_minus_credit` は借方正、`closing_balance` は科目グループの通常残高方向（資産・費用は借方、負債・資本・収益は貸方）に換算する。

各実行は新しい作業フォルダに保存する。フォルダ 700 / ファイル 600。以前の結果や秘密は上書き・出力しない。標準出力は件数・取得回数・所要時間・ファイルパスのみ。明細本文は私有 JSON に保存する。

一括取得・確認の GET は既定30秒で打ち切る。ネットワーク失敗・タイムアウト・HTTP 502/503/504だけ1回再取得し、4xxや不完全データは自動再送しない。必要なら実行環境の `MF_BATCH_REQUEST_TIMEOUT_MS` で読取待ち時間を指定する（100〜60000ミリ秒）。既存の帳簿書込にはこの再取得処理を適用しない。

取得途中で失敗しても、成功したAPI応答は私有キャッシュに保存する。エラーに出るディレクトリを `scan --resume-cache` / MCP `resume_cache` に渡すと、同じ事業者・年度・取得範囲で成功済みの応答を再利用する。既定5分より古い応答は取り直す。保存済みデータの再判定だけなら期限で取り直すscanではなく `reconcile` を使う。`MF_BATCH_CACHE_MAX_AGE_MS` で再開時の許容時間、`MF_BATCH_CONCURRENCY` で並行取得数（既定4、最大8）を指定できる。キャッシュの使用時刻・再利用数は結果に記録する。

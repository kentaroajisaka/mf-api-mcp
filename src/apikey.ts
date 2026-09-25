/**
 * APIキー認証。OAuth と違い「アプリ」の概念が無い。
 *
 *   APIキー（期限なし） → POST /auth/exchange → JWT（1時間）
 *
 * OAuth の refresh_token と違い **APIキーの値は使っても変わらない**ので、
 * 複数の環境が同じキーを持っても互いを無効化しない（取り合いが起きない）。
 *
 * キーの渡し方（優先順）:
 *   1. 環境変数 MF_API_KEY
 *   2. 環境変数 MF_API_KEY_FILE が指すファイル
 *   3. ~/.mf-api-key
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXCHANGE_URL = "https://api.biz.moneyforward.com/auth/exchange";
const TENANT_URL = "https://api.biz.moneyforward.com/v2/tenant/tenant_user";

let cached: { jwt: string; expiresAt: number } | null = null;

export function readApiKey(): string {
  const direct = process.env.MF_API_KEY?.trim();
  if (direct) return direct;

  const path = process.env.MF_API_KEY_FILE?.trim() || join(homedir(), ".mf-api-key");
  try {
    const v = readFileSync(path, "utf8").trim();
    if (v) return v;
  } catch {
    /* 下でまとめてエラーにする */
  }
  throw new Error(
    "APIキーが見つかりません。環境変数 MF_API_KEY か、~/.mf-api-key（600）に入れてください。\n" +
      "発行: アプリポータル → APIキー管理 → 複数事業者タブ → 新規登録\n" +
      "  利用可能サービス: 会計 と 事業者情報\n" +
      "  利用可能事業者: **ページ送りがあるので全ページ選ぶこと**（1ページ分しか選ばれない事故が起きる）"
  );
}

/** JWT を取得する。1時間有効なので期限の1分前まで使い回す。 */
export async function getJwt(force = false): Promise<string> {
  if (!force && cached && Date.now() < cached.expiresAt - 60_000) return cached.jwt;

  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${readApiKey()}`, Accept: "application/json" },
  });
  const text = await res.text();

  if (res.status === 429) {
    const retry = res.headers.get("Retry-After");
    throw new Error(
      `APIキーの交換がレート制限に当たりました（毎分100回）。${retry ? `${retry}秒` : "しばらく"}待ってください。`
    );
  }
  if (!res.ok) {
    throw new Error(
      `APIキーの交換に失敗しました: HTTP ${res.status}\n${text}\n` +
        (res.status === 401 ? "キーが無効か失効しています。アプリポータルで確認してください。" : "")
    );
  }

  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error(`交換の応答に access_token がありません:\n${text}`);

  cached = { jwt: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.jwt;
}

export type Office = {
  office_code: string;
  name: string;
  roles: string[];
  has_accounting: boolean;
};

/**
 * このキーで使える事業者の一覧。
 * OAuth 版のような自前のトークン台帳は要らない。MF が持っているものを引くだけ。
 */
export async function listOffices(): Promise<Office[]> {
  const res = await fetch(TENANT_URL, {
    headers: { Authorization: `Bearer ${await getJwt()}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`事業者一覧の取得に失敗: HTTP ${res.status}\n${text}`);

  const items = (JSON.parse(text).items ?? []) as Array<{
    tenant_code: string;
    tenant_name: string;
    tenant_user_roles?: string[];
  }>;
  return items.map((o) => {
    const roles = o.tenant_user_roles ?? [];
    return {
      office_code: o.tenant_code,
      name: o.tenant_name,
      roles,
      has_accounting: roles.some((r) => r.includes("会計")),
    };
  });
}

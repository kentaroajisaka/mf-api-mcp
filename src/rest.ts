import { getJwt } from "./apikey.js";

const API_BASE = "https://api-accounting.moneyforward.com/api/v3";

/**
 * MF の ID は Base64 の URL エンコード済み文字列（%2F 等を含む）。
 * URL パスに埋める際は全体を再エンコードしないと %2F がスラッシュに
 * デコードされてパスが壊れ 403 になる（mf-official-mcp スキル既知の罠）。
 */
export function encodePathId(id: string): string {
  return encodeURIComponent(id);
}

/**
 * MF の ID はエンコード済み(%3D等)で渡ってくるため、URLSearchParams に通すと
 * 二重エンコードになる。%XX を含む値はそのまま、それ以外だけエンコードする。
 * 配列パラメータは `k=v1&k=v2` 形式（`[]` 付きは unsupported_query_parameter になる）。
 */
function encodeQueryValue(v: string): string {
  return /%[0-9A-Fa-f]{2}/.test(v) ? v : encodeURIComponent(v);
}

/**
 * 既定の事業者。MF_OFFICE_CODE で固定できる。
 * 指定が無ければ呼び出しごとに office_code を渡す必要がある。
 */
export function defaultOfficeCode(): string | undefined {
  return process.env.MF_OFFICE_CODE?.trim() || undefined;
}

export async function api(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown; officeCode?: string } = {}
): Promise<string> {
  // APIキー認証では office_code が必須。無いと 400 missing_required_query_parameter。
  // ツール側は引数にそのまま office_code を受けるので query からも拾う。
  const fromQuery = opts.query?.office_code;
  const office =
    opts.officeCode ?? (typeof fromQuery === "string" && fromQuery ? fromQuery : undefined) ?? defaultOfficeCode();
  if (!office) {
    throw new Error(
      "office_code が指定されていません。APIキー認証では事業者番号（XXXX-XXXX）が必須です。\n" +
        "list_offices で一覧を確認して office_code を渡すか、環境変数 MF_OFFICE_CODE で既定を決めてください。"
    );
  }

  const qs: string[] = [`office_code=${encodeQueryValue(office)}`];
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null || k === "office_code") continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const item of vals) qs.push(`${k}=${encodeQueryValue(String(item))}`);
  }
  const url = `${API_BASE}${path}?${qs.join("&")}`;

  const doFetch = async (jwt: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(await getJwt());

  // JWT は1時間で切れる。401 は一度だけ取り直してリトライ。
  if (res.status === 401) {
    res = await doFetch(await getJwt(true));
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MF API error: HTTP ${res.status} ${method} ${path} (office=${office})\n${text}`);
  }
  return text || JSON.stringify({ status: res.status, ok: true });
}

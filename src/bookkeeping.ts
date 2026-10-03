import { z } from "zod";
import { cloudBoxFileUrls, memoEvidenceUrls } from "./evidence-urls.js";

// API schema constants are fixed; companies, periods, ledgers and decisions are inputs.
const id = z.string().min(1);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
  "Invalid calendar date",
);
const yen = z.number().int().safe();
export const sideSchema = z.object({
  account_id: id, account_name: z.string().optional(),
  sub_account_id: id.nullable().optional(), sub_account_name: z.string().nullable().optional(),
  value: yen, tax_value: yen,
}).passthrough();
export const journalSchema = z.object({
  id, number: z.number().int(), transaction_date: date, journal_type: z.string(),
  transaction_id: id.nullable().optional(), update_time: z.string().optional(),
  memo: z.string().nullable().optional(), tags: z.array(z.string()).optional(),
  voucher_file_ids: z.array(id),
  branches: z.array(z.object({
    debitor: sideSchema.nullable(), creditor: sideSchema.nullable(),
    remark: z.string().nullable().optional(),
  }).passthrough()).min(1),
}).passthrough();
export const transactionSchema = z.object({
  id, date, value: yen.nonnegative(), side: z.enum(["INCOME", "EXPENSE"]), content: z.string().nullable(),
  connected_account_id: id, connected_sub_account_id: id.nullable().optional(),
  journalizing_status: z.string(), voucher_file_ids: z.array(id),
}).passthrough();
export const termSchema = z.object({
  fiscal_year: z.number().int(), start_date: date, end_date: date, accounting_method: z.string(),
}).passthrough();
const accountSchema = z.object({ id, name: z.string(), available: z.boolean().optional() }).passthrough();
const subSchema = z.object({ id, account_id: id, name: z.string() }).passthrough();
const connectionLedger = z.object({
  id, name: z.string(), account_id: id.nullable().optional(), sub_account_id: id.nullable().optional(),
}).passthrough();
export const snapshotSchema = z.object({
  schema_version: z.literal(1), office_code: id, term: termSchema,
  start_date: date, end_date: date, started_at: z.string(), completed_at: z.string(),
  detail_complete: z.boolean(), api_calls: z.number().int(),
  pending: z.array(transactionSchema), transactions: z.array(transactionSchema),
  journals: z.array(journalSchema),
  accounts: z.array(accountSchema), sub_accounts: z.array(subSchema),
  connected_accounts: z.array(connectionLedger.extend({ connected_sub_accounts: z.array(connectionLedger) })),
  taxes: z.array(z.unknown()), departments: z.array(z.unknown()),
  trial_balance: z.object({ bs: z.unknown(), pl: z.unknown(), end_date: date }).optional(),
  read_cache: z.object({ directory: z.string(), reused_responses: z.number().int(), oldest_response_at: z.string() }).optional(),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Journal = z.infer<typeof journalSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type Side = z.infer<typeof sideSchema>;

const selector = z.object({ id: id.optional(), name: id.optional() }).strict()
  .refine((v) => Boolean(v.id) !== Boolean(v.name), "Specify exactly one of id or name");
export const configSchema = z.object({
  office_code: id,
  // A migration may use a different ledger from the connection's present configuration.
  bindings: z.array(z.object({
    connected_account_id: id, connected_sub_account_id: id.nullable(),
    account: selector, sub_account: selector.nullable(), reason: id,
  }).strict()).default([]),
  // Exact strings only; no broad regular expressions or automatic substring acceptance.
  content_aliases: z.array(z.object({
    connected_account_id: id, connected_sub_account_id: id.nullable(),
    transaction_content: id, journal_remark: id, reason: id,
  }).strict()).default([]),
}).strict();
export type Config = z.infer<typeof configSchema>;

export function gross(s: Side | null): number {
  if (!s) return 0;
  const result = s.value + s.tax_value;
  if (!Number.isSafeInteger(result)) throw new Error("Unsafe monetary sum");
  return result;
}
export function normalize(s: string): string {
  // Preserve punctuation, digits and long vowel marks; they may distinguish merchants/cards.
  return s.normalize("NFKC").toLocaleUpperCase("ja-JP").replace(/\s+/gu, "");
}
function unique(rows: { id: string }[], label: string) {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error(`Duplicate ${label} IDs`);
}
export function validateSnapshot(raw: unknown): Snapshot {
  const s = snapshotSchema.parse(raw);
  if (s.start_date < s.term.start_date || s.end_date > s.term.end_date || s.start_date > s.end_date)
    throw new Error("Snapshot period is outside its fiscal term");
  for (const name of ["pending", "transactions", "journals", "accounts", "sub_accounts", "connected_accounts"] as const)
    unique(s[name], name);
  for (const t of [...s.pending, ...s.transactions]) {
    if (t.date < s.start_date || t.date > s.end_date) throw new Error("Transaction outside requested period");
  }
  if (s.pending.some((t) => t.journalizing_status !== "none")) throw new Error("Non-pending transaction in pending list");
  for (const j of s.journals) {
    if (j.transaction_date < s.term.start_date || j.transaction_date > s.term.end_date)
      throw new Error("Journal outside fiscal term");
  }
  if (s.detail_complete) {
    const pending = s.transactions.filter((t) => t.journalizing_status === "none").map((t) => t.id).sort();
    if (JSON.stringify(pending) !== JSON.stringify(s.pending.map((t) => t.id).sort()))
      throw new Error("Pending transactions changed during collection; collect a fresh snapshot");
  } else if (s.pending.length || s.journals.length || s.transactions.length) {
    throw new Error("Incomplete snapshots are allowed only for the zero-pending fast path");
  }
  return s;
}

function resolve<T extends { id: string; name: string }>(rows: T[], wanted: z.infer<typeof selector>, label: string): T {
  const matches = rows.filter((r) => wanted.id ? r.id === wanted.id : r.name === wanted.name);
  if (matches.length !== 1) throw new Error(`${label} must resolve uniquely in current masters`);
  return matches[0];
}
function sameConnection(a: { connected_account_id: string; connected_sub_account_id?: string | null }, b: Transaction) {
  return a.connected_account_id === b.connected_account_id &&
    (a.connected_sub_account_id ?? null) === (b.connected_sub_account_id ?? null);
}
function ledgerFor(s: Snapshot, t: Transaction, c: Config) {
  const connection = s.connected_accounts.find((a) => a.id === t.connected_account_id);
  if (!connection) throw new Error("Unknown connected account");
  const sub = t.connected_sub_account_id == null ? undefined :
    connection.connected_sub_accounts.find((a) => a.id === t.connected_sub_account_id);
  if (t.connected_sub_account_id != null && !sub) throw new Error("Unknown connected sub-account");
  const overrides = c.bindings.filter((a) => sameConnection(a, t));
  if (overrides.length > 1) throw new Error("Duplicate ledger bindings");
  const configured = sub ?? connection;
  const rule = overrides[0];
  const accountId = rule ? resolve(s.accounts, rule.account, "Account").id : configured.account_id;
  if (!accountId) throw new Error("Missing settlement account");
  const account = s.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("Settlement account absent from current masters");
  const subId = rule ? (rule.sub_account ? resolve(s.sub_accounts.filter((a) => a.account_id === accountId), rule.sub_account, "Sub-account").id : null) :
    (configured.sub_account_id ?? null);
  if (subId && !s.sub_accounts.some((a) => a.id === subId && a.account_id === accountId))
    throw new Error("Settlement sub-account absent from its account");
  return {
    account_id: accountId, sub_account_id: subId, account_name: account.name,
    sub_account_name: s.sub_accounts.find((a) => a.id === subId)?.name ?? null,
    service: connection.name, user_or_account: sub?.name ?? null,
    source: rule ? "runtime_binding" : "connected_account_settings", reason: rule?.reason ?? null,
  };
}
type Ledger = ReturnType<typeof ledgerFor>;
function net(j: Journal, ledger: Ledger): number {
  let result = 0;
  for (const b of j.branches) {
    for (const [side, sign] of [[b.debitor, 1], [b.creditor, -1]] as const) {
      if (side?.account_id === ledger.account_id && (side.sub_account_id ?? null) === ledger.sub_account_id)
        result += sign * gross(side);
    }
  }
  if (!Number.isSafeInteger(result)) throw new Error("Unsafe journal total");
  return result;
}
function contentMatches(j: Journal, t: Transaction, c: Config, ledger?: Ledger): boolean {
  const content = normalize(t.content ?? "");
  if (!content) return false;
  const relevant = ledger ? j.branches.filter((b) => [b.debitor, b.creditor].some((s) =>
    s?.account_id === ledger.account_id && (s.sub_account_id ?? null) === ledger.sub_account_id && gross(s) !== 0)) : j.branches;
  return relevant.length > 0 && relevant.every((b) => {
    const remark = normalize(b.remark ?? "");
    return remark === content || c.content_aliases.some((a) => sameConnection(a, t) &&
      normalize(a.transaction_content) === content && normalize(a.journal_remark) === remark);
  });
}
export function describeJournal(j: Journal) {
  function side(s: Side | null) {
    return s ? { ...s, gross_value: gross(s) } : null;
  }
  return {
    id: j.id, number: j.number, date: j.transaction_date, transaction_id: j.transaction_id ?? null,
    update_time: j.update_time, voucher_file_ids: j.voucher_file_ids,
    voucher_urls: j.voucher_file_ids.filter((id) => z.string().uuid().safeParse(id).success).map(cloudBoxFileUrls),
    memo_evidence_urls: memoEvidenceUrls(j.memo),
    // Presence alone does not establish what the receipt proves.
    evidence_status: j.voucher_file_ids.length ? "attached_content_unchecked" : "attachment_absent_other_sources_unchecked",
    branches: j.branches.map((b) => ({ debitor: side(b.debitor), creditor: side(b.creditor), remark: b.remark ?? "" })),
  };
}

export function reconcile(rawSnapshot: unknown, rawConfig?: unknown) {
  const s = validateSnapshot(rawSnapshot);
  const c = configSchema.parse(rawConfig ?? { office_code: s.office_code });
  if (c.office_code !== s.office_code) throw new Error("Configuration belongs to a different office");
  const journalById = new Map(s.journals.map((j) => [j.id, j]));
  const byDate = new Map<string, Journal[]>();
  for (const j of s.journals) byDate.set(j.transaction_date, [...(byDate.get(j.transaction_date) ?? []), j]);
  const rows = s.pending.map((t) => {
    let ledger: Ledger;
    try { ledger = ledgerFor(s, t, c); }
    catch (e) { return { transaction: t, ledger: null, eligible_ids: [] as string[], candidate_ids: [] as string[], reasons: [String((e as Error).message)] }; }
    const wanted = t.value * (t.side === "INCOME" ? 1 : -1);
    const candidates = (byDate.get(t.date) ?? []).filter((j) => net(j, ledger) === wanted && wanted !== 0);
    const eligible = candidates.filter((j) => !j.transaction_id && contentMatches(j, t, c, ledger));
    return {
      transaction: t, ledger, eligible_ids: eligible.map((j) => j.id), candidate_ids: candidates.map((j) => j.id),
      reasons: eligible.length === 1 ? [] : [eligible.length > 1 ? "ambiguous_multiple_journals" :
        candidates.length ? "content_mismatch_or_already_linked" : "no_same_date_direction_ledger_amount_match"],
    };
  });
  const claims = new Map<string, number>();
  for (const row of rows) for (const id of row.eligible_ids) claims.set(id, (claims.get(id) ?? 0) + 1);
  const items = rows.map((row) => {
    if (row.eligible_ids.some((id) => claims.get(id)! > 1)) row.reasons.push("journal_claimed_by_multiple_transactions");
    return {
      transaction: row.transaction, ledger: row.ledger,
      status: row.reasons.length ? "review" : "matched_candidate",
      reasons: row.reasons.length ? row.reasons : ["unique_date_direction_gross_ledger_content_match"],
      matched_journal_ids: row.reasons.length ? [] : row.eligible_ids,
      candidates: row.candidate_ids.map((id) => describeJournal(journalById.get(id)!)),
    };
  });
  // Registered feeds are audited separately; never describe them as pending transactions.
  const transactions = new Map(s.transactions.map((t) => [t.id, t]));
  const linkedIssues = s.journals.filter((j) => j.transaction_id && j.transaction_date >= s.start_date && j.transaction_date <= s.end_date)
    .flatMap((j) => {
      const t = transactions.get(j.transaction_id!);
      const reasons: string[] = [];
      if (!t) reasons.push("linked_transaction_not_in_snapshot");
      else {
        if (t.date !== j.transaction_date) reasons.push("linked_date_mismatch");
        if (!contentMatches(j, t, c)) reasons.push("linked_content_mismatch");
        try {
          if (net(j, ledgerFor(s, t, c)) !== t.value * (t.side === "INCOME" ? 1 : -1))
            reasons.push("linked_direction_ledger_amount_mismatch");
        } catch (e) { reasons.push((e as Error).message); }
        if (!["registered", "modified", "new_voucher_attached"].includes(t.journalizing_status))
          reasons.push("linked_transaction_status_requires_review");
      }
      return reasons.length ? [{ transaction: t ?? null, journal: describeJournal(j), reasons }] : [];
    });
  return {
    schema_version: 1, office_code: s.office_code, fiscal_year: s.term.fiscal_year,
    start_date: s.start_date, end_date: s.end_date, source_completed_at: s.completed_at,
    summary: { pending: s.pending.length, matched_candidates: items.filter((r) => r.status === "matched_candidate").length,
      review: items.filter((r) => r.status === "review").length, linked_issues: linkedIssues.length,
      detail_complete: s.detail_complete },
    action: "read_only_candidates_revalidate_before_UI_exclusion",
    items, linked_issues: linkedIssues,
    // This is a verification input, not permission or an instruction to exclude candidates.
    candidate_verification_manifest: {
      office_code: s.office_code,
      journal_ids: items.flatMap((r) => r.matched_journal_ids),
      expected_statuses: items.map((r) => ({ transaction_id: r.transaction.id,
        status: r.status === "matched_candidate" ? "excluded" : "none" })),
    },
  };
}

// Identity-aware diffs avoid array-position changes masquerading as balance changes.
export function differences(before: unknown, after: unknown, path = ""): { path: string; before: unknown; after: unknown; delta?: number }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyFor = (r: any) => r && typeof r === "object" ? (r.id ?? r.sub_account_id ?? r.account_id ?? r.name) : undefined;
    const keys = (rs: any[]) => rs.map(keyFor);
    if ([before, after].every((rs) => keys(rs).every((k) => typeof k === "string") && new Set(keys(rs)).size === rs.length)) {
      const a = Object.fromEntries(before.map((r) => [keyFor(r), r]));
      const b = Object.fromEntries(after.map((r) => [keyFor(r), r]));
      return differences(a, b, path);
    }
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) =>
      differences(a[k] ?? null, b[k] ?? null, `${path}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  return [{ path, before: before ?? null, after: after ?? null,
    ...(typeof before === "number" && typeof after === "number" ? { delta: after - before } : {}) }];
}

export function reportDifferences(before: unknown, after: unknown) {
  // Trial-balance generation time changes on every GET; retain it in raw evidence only.
  return differences(before, after).filter((d) => d.path !== "/created_at");
}

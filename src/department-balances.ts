import { z } from "zod";
import { date, gross, validateSnapshot, type Snapshot } from "./bookkeeping.js";

const identity = z.string().min(1);
export const departmentOpeningSchema = z.object({
  office_code: identity, fiscal_year: z.number().int(), as_of_date: date,
  basis: z.enum(["gross", "net"]), source: identity,
  rows: z.array(z.object({
    department_id: identity.nullable(), account_id: identity, sub_account_id: identity.nullable(),
    opening_debit_minus_credit: z.number().int().safe(),
  }).strict()),
}).strict();
const rowKey = (department: string | null, account: string, sub: string | null) => JSON.stringify([department, account, sub]);
function safeSum(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new Error("Unsafe department monetary total");
  return n;
}

/** MF が期首残高を入れた仕訳（開始仕訳）。期中の動きではなく期首残高として扱う。 */
export const OPENING_JOURNAL = "JOURNAL_TYPE_OPENING";
const isOpeningJournal = (j: Record<string, unknown>) => j.entered_by === OPENING_JOURNAL;

type TrialRow = { name?: unknown; type?: unknown; values?: unknown; rows?: unknown };
/** 試算表（貸借対照表）の科目ごとの期首残高。科目名で返す（試算表には科目IDが無い）。 */
function trialOpenings(bs: unknown) {
  const out = new Map<string, { opening: number; sign: 1 | -1 } | null>();
  const walk = (rows: unknown, sign: 1 | -1 | null) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows as TrialRow[]) {
      const here = r.type === "assets" ? 1 : r.type === "liabilities" || r.type === "net_assets" ? -1 :
        r.type === "liabilities_net_assets" ? null : sign;
      if (r.type === "account" && typeof r.name === "string" && here && Array.isArray(r.values) && typeof r.values[0] === "number") {
        out.set(r.name, out.has(r.name) ? null : { opening: r.values[0], sign: here }); // 同じ名前が2つあれば照合しない
      }
      if (r.type !== "liabilities_net_assets") walk(r.rows, here);
    }
  };
  walk((bs as { rows?: unknown } | null)?.rows, null);
  return out;
}

/** Side-specific direct department assignments, including unassigned. Opening balances come from MF opening journals unless supplied. */
export function departmentBalances(raw: unknown, openingRaw?: unknown) {
  const s: Snapshot = validateSnapshot(raw);
  if (!s.detail_complete) throw new Error("Department balances require a full annual journal snapshot");
  const basis = s.term.accounting_method === "TAX_INCLUDED" ? "gross" :
    ["TAX_EXCLUDED", "TAX_SEPARATED"].includes(s.term.accounting_method) ? "net" : undefined;
  if (!basis) throw new Error("Unsupported accounting method for department aggregation");
  const opening = openingRaw === undefined ? undefined : departmentOpeningSchema.parse(openingRaw);
  if (opening) {
    const previousDay = new Date(Date.parse(s.term.start_date) - 86400000).toISOString().slice(0, 10);
    if (opening.office_code !== s.office_code || opening.fiscal_year !== s.term.fiscal_year || opening.as_of_date !== previousDay || opening.basis !== basis)
      throw new Error("Department opening balances have different office, fiscal year, date, or monetary basis");
  }
  const accounts = new Map(s.accounts.map((a) => [a.id, a]));
  const departments = new Map<string, { name: string; parent_id?: string | null }>();
  for (const raw of s.departments) {
    const d = z.object({ id: identity, name: z.string(), parent_id: identity.nullable().optional() }).passthrough().parse(raw);
    if (departments.has(d.id)) throw new Error("Duplicate department IDs");
    departments.set(d.id, d);
  }
  type Row = {
    id: string; department_id: string | null; department_name: string; parent_department_id: string | null;
    account_id: string; account_name: string; sub_account_id: string | null; sub_account_name: string | null;
    balance_direction: "debit" | "credit" | null;
    opening_debit_minus_credit: number | null; debit_amount: number; credit_amount: number;
    period_debit_minus_credit: number; closing_debit_minus_credit: number | null; closing_balance: number | null;
  };
  const rows = new Map<string, Row>();
  const row = (departmentId: string | null, accountId: string, subId: string | null, accountName?: string, departmentName?: string) => {
    const key = rowKey(departmentId, accountId, subId);
    let r = rows.get(key);
    if (!r) {
      const account = accounts.get(accountId), department = departmentId ? departments.get(departmentId) : undefined;
      const group = account?.account_group;
      const direction = ["ASSET", "EXPENSE"].includes(String(group)) ? "debit" : ["LIABILITY", "CAPITAL", "REVENUE"].includes(String(group)) ? "credit" : null;
      r = { id: key, department_id: departmentId,
        department_name: department?.name ?? departmentName ?? (departmentId ? "部門マスター未確認" : "部門未設定"),
        parent_department_id: department?.parent_id ?? null,
        account_id: accountId, account_name: account?.name ?? accountName ?? "科目マスター未確認",
        sub_account_id: subId, sub_account_name: s.sub_accounts.find((sub) => sub.id === subId && sub.account_id === accountId)?.name ?? null,
        balance_direction: direction, opening_debit_minus_credit: null, debit_amount: 0, credit_amount: 0,
        period_debit_minus_credit: 0, closing_debit_minus_credit: null, closing_balance: null };
      rows.set(key, r);
    }
    return r;
  };
  const openingKeys = new Set<string>();
  for (const seed of opening?.rows ?? []) {
    const key = rowKey(seed.department_id, seed.account_id, seed.sub_account_id);
    if (openingKeys.has(key)) throw new Error("Duplicate department opening balance");
    openingKeys.add(key);
    if (!accounts.has(seed.account_id) || (seed.sub_account_id && !s.sub_accounts.some((sub) => sub.id === seed.sub_account_id && sub.account_id === seed.account_id)))
      throw new Error("Opening account/sub-account absent from its current master");
    if (seed.department_id && !departments.has(seed.department_id)) throw new Error("Opening department absent from current master");
    row(seed.department_id, seed.account_id, seed.sub_account_id).opening_debit_minus_credit = seed.opening_debit_minus_credit;
  }
  let included = 0, excludedUnrealized = 0, replacedOpening = 0;
  const openingJournals: number[] = [];
  for (const j of s.journals) {
    if (j.transaction_date < s.term.start_date || j.transaction_date > s.end_date) continue;
    if (j.is_realized === false) { excludedUnrealized++; continue; }
    if (j.is_realized !== true) throw new Error("Journal realization status is missing; department totals cannot be certified");
    const openingJournal = isOpeningJournal(j);
    // 期首残高を別に渡されたときは、MF の開始仕訳を数えない（二重計上を防ぐ）
    if (openingJournal && opening) { replacedOpening++; continue; }
    if (openingJournal) openingJournals.push(j.number); else included++;
    for (const branch of j.branches) for (const [side, kind] of [[branch.debitor, "debit_amount"], [branch.creditor, "credit_amount"]] as const) {
      if (!side) continue;
      if (side.department_id !== null && typeof side.department_id !== "string")
        throw new Error("Journal side department_id is missing or invalid");
      const r = row(side.department_id as string | null, side.account_id, side.sub_account_id ?? null,
        side.account_name, typeof side.department_name === "string" ? side.department_name : undefined);
      const amount = basis === "gross" ? gross(side) : side.value;
      if (openingJournal) r.opening_debit_minus_credit = safeSum(r.opening_debit_minus_credit ?? 0, kind === "debit_amount" ? amount : -amount);
      else r[kind] = safeSum(r[kind], amount);
    }
  }
  // MF の期首残高は開始仕訳がすべて。開始仕訳に出てこない組の期首は0（期首残高を渡されたときは、渡された組だけ）
  if (!opening) for (const r of rows.values()) if (r.opening_debit_minus_credit === null) r.opening_debit_minus_credit = 0;
  for (const r of rows.values()) {
    r.period_debit_minus_credit = safeSum(r.debit_amount, -r.credit_amount);
    if (r.opening_debit_minus_credit !== null) {
      r.closing_debit_minus_credit = safeSum(r.opening_debit_minus_credit, r.period_debit_minus_credit);
      if (r.balance_direction) r.closing_balance = r.closing_debit_minus_credit * (r.balance_direction === "debit" ? 1 : -1);
    }
  }
  // 試算表の期首残高（全部門・全補助科目の合計）と、科目ごとに突き合わせる
  let openingCheck: { compared_accounts: number; mismatches: { account_name: string; trial_balance: number; journals: number }[] } | null = null;
  if (s.trial_balance) {
    const trial = trialOpenings(s.trial_balance.bs), byName = new Map<string, number>();
    for (const r of rows.values()) byName.set(r.account_name, safeSum(byName.get(r.account_name) ?? 0, r.opening_debit_minus_credit ?? 0));
    const mismatches: { account_name: string; trial_balance: number; journals: number }[] = [];
    let compared = 0;
    for (const [name, t] of trial) {
      if (!t) continue;
      compared++;
      const mine = (byName.get(name) ?? 0) * t.sign;
      if (mine !== t.opening) mismatches.push({ account_name: name, trial_balance: t.opening, journals: mine });
    }
    openingCheck = { compared_accounts: compared, mismatches };
  }
  const knownOpening = [...rows.values()].filter((r) => r.opening_debit_minus_credit !== null).length;
  return {
    office_code: s.office_code, fiscal_year: s.term.fiscal_year,
    start_date: s.term.start_date, end_date: s.end_date, basis,
    aggregation: "direct_side_department_account_sub_account_including_unassigned",
    opening_source: opening?.source ?? (openingJournals.length ? "mf_opening_journals" : "no_opening_journal_zero"),
    opening_journal_numbers: openingJournals,
    opening_check: openingCheck,
    summary: { included_journals: included, opening_journals: openingJournals.length, replaced_opening_journals: replacedOpening,
      excluded_unrealized: excludedUnrealized,
      rows: rows.size, rows_with_known_opening: knownOpening, rows_with_unknown_opening: rows.size - knownOpening,
      opening_mismatches: openingCheck ? openingCheck.mismatches.length : null },
    rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
    note: "期首残高は MF の開始仕訳（entered_by=JOURNAL_TYPE_OPENING）から部門・科目・補助科目ごとに取り、期中の借方・貸方には入れない。開始仕訳に無い組の期首は0。期首残高を別に渡したときは開始仕訳を数えず、渡した組だけ期末残高を出す。試算表の期首残高と科目ごとに照合する（opening_check）。親部門の合計は足さない。借方・貸方はそれぞれの部門IDで集計する。",
  };
}

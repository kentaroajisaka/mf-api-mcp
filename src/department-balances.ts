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

/** Side-specific direct department assignments, including unassigned. No guessed opening balances. */
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
  let included = 0, excludedUnrealized = 0;
  for (const j of s.journals) {
    if (j.transaction_date < s.term.start_date || j.transaction_date > s.end_date) continue;
    if (j.is_realized === false) { excludedUnrealized++; continue; }
    if (j.is_realized !== true) throw new Error("Journal realization status is missing; department totals cannot be certified");
    included++;
    for (const branch of j.branches) for (const [side, kind] of [[branch.debitor, "debit_amount"], [branch.creditor, "credit_amount"]] as const) {
      if (!side) continue;
      if (side.department_id !== null && typeof side.department_id !== "string")
        throw new Error("Journal side department_id is missing or invalid");
      const r = row(side.department_id as string | null, side.account_id, side.sub_account_id ?? null,
        side.account_name, typeof side.department_name === "string" ? side.department_name : undefined);
      r[kind] = safeSum(r[kind], basis === "gross" ? gross(side) : side.value);
    }
  }
  for (const r of rows.values()) {
    r.period_debit_minus_credit = safeSum(r.debit_amount, -r.credit_amount);
    if (r.opening_debit_minus_credit !== null) {
      r.closing_debit_minus_credit = safeSum(r.opening_debit_minus_credit, r.period_debit_minus_credit);
      if (r.balance_direction) r.closing_balance = r.closing_debit_minus_credit * (r.balance_direction === "debit" ? 1 : -1);
    }
  }
  return {
    office_code: s.office_code, fiscal_year: s.term.fiscal_year,
    start_date: s.term.start_date, end_date: s.end_date, basis,
    aggregation: "direct_side_department_account_sub_account_including_unassigned",
    opening_source: opening?.source ?? null,
    summary: { included_journals: included, excluded_unrealized: excludedUnrealized,
      rows: rows.size, rows_with_known_opening: openingKeys.size, rows_with_unknown_opening: rows.size - openingKeys.size },
    rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
    note: "Without supplied opening balances, only period movements and their changes are verified. Parent department totals are not added to direct rows; debit and credit use their own department IDs.",
  };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { api, encodePathId } from "./rest.js";
import { z } from "zod";
import { departmentBalances, departmentOpeningSchema } from "./department-balances.js";
import { configSchema, date, differences, journalSchema, reconcile, reportDifferences, termSchema, transactionSchema, validateSnapshot, type Snapshot } from "./bookkeeping.js";

export type ReadApi = (path: string, query?: Record<string, unknown>) => Promise<unknown>;
const metadataSchema = z.object({ total_count: z.number().int().nonnegative(), total_pages: z.number().int().nonnegative() });

export function retryRead(read: ReadApi): ReadApi {
  return async (path, query) => {
    for (let attempt = 0; ; attempt++) {
      try { return await read(path, query); }
      catch (error) {
        const e = error as Error;
        const transient = ["TimeoutError", "AbortError"].includes(e.name) ||
          (e instanceof TypeError && e.message === "fetch failed") || /HTTP (502|503|504)\b/.test(e.message);
        if (attempt || !transient) throw new Error(`GET ${path}: ${e.message}`, { cause: error });
        // GET only. Never retry a validation failure, 4xx, or an accounting write.
        await delay(250);
      }
    }
  };
}
function liveReader(officeCode: string, onAttempt: () => void = () => {}) {
  const timeout = z.coerce.number().int().min(100).max(60000).parse(process.env.MF_BATCH_REQUEST_TIMEOUT_MS ?? 30000);
  const concurrency = z.coerce.number().int().min(1).max(8).parse(process.env.MF_BATCH_CONCURRENCY ?? 4);
  let active = 0;
  const queue: (() => void)[] = [];
  return retryRead(async (path, query) => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      onAttempt();
      return JSON.parse(await api("GET", path, { officeCode, query, signal: AbortSignal.timeout(timeout) }));
    } finally {
      const next = queue.shift();
      if (next) next(); else active--;
    }
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function cacheReader(read: ReadApi, cacheDir: string, scope: ScanInput, maxAgeMs = 300000) {
  if (!isAbsolute(cacheDir)) throw new Error("resume_cache must be an absolute path");
  const normalized = scanSchema.parse(scope);
  if (canonical(scanSchema.parse(await readJson(join(cacheDir, "collection.json")))) !== canonical(normalized))
    throw new Error("Read cache belongs to a different office, fiscal year, or collection request");
  const stats = { reused_responses: 0, oldest_response_at: new Date().toISOString() };
  let sawResponse = false;
  const recordTime = (time: string) => {
    if (!sawResponse || time < stats.oldest_response_at) stats.oldest_response_at = time;
    sawResponse = true;
  };
  const wrapped: ReadApi = async (path, query) => {
    const request = { path, query: query ?? {} };
    const digest = createHash("sha256").update(canonical(request)).digest("hex");
    const file = join(cacheDir, `${digest}.json`);
    try {
      const cached = z.object({ request: z.unknown(), captured_at: z.string().datetime(), body: z.unknown() }).parse(await readJson(file));
      if (canonical(cached.request) !== canonical(request)) throw new Error("Read cache request mismatch");
      const age = Date.now() - Date.parse(cached.captured_at);
      if (age >= 0 && age <= maxAgeMs) {
        stats.reused_responses++;
        recordTime(cached.captured_at);
        return cached.body;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const body = await read(path, query);
    const captured = new Date().toISOString();
    recordTime(captured);
    // A unique file followed by rename leaves a complete response even if the process stops.
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ request, captured_at: captured, body }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(temp, file);
    return body;
  };
  return { read: wrapped, stats };
}

export async function pages(read: ReadApi, path: string, key: string, limit: number, query: Record<string, unknown> = {}): Promise<any[]> {
  const result: any[] = [];
  const seen = new Set<string>();
  let expected: z.infer<typeof metadataSchema> | undefined;
  for (let page = 1; ; page++) {
    const response = z.record(z.unknown()).parse(await read(path, { ...query, per_page: limit, page }));
    const meta = metadataSchema.parse(response.metadata);
    const rows = z.array(z.object({ id: z.string().min(1) }).passthrough()).parse(response[key]);
    if (meta.total_pages !== Math.ceil(meta.total_count / limit))
      throw new Error(`${path}: inconsistent pagination metadata`);
    if (expected && (meta.total_count !== expected.total_count || meta.total_pages !== expected.total_pages))
      throw new Error(`${path}: count changed while paging; collect again`);
    expected = meta;
    const expectedSize = Math.min(limit, Math.max(0, meta.total_count - (page - 1) * limit));
    if (rows.length !== expectedSize) throw new Error(`${path}: incomplete page ${page}`);
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error(`${path}: duplicate ID across pages`);
      seen.add(row.id); result.push(row);
    }
    if (page >= meta.total_pages) return result;
  }
}
async function batch<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const errors = results.flatMap((r) => r.status === "rejected" ? [String(r.reason)] : []);
  if (errors.length) throw new Error(errors.join("\n"));
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
async function list(read: ReadApi, path: string, key: string, query?: Record<string, unknown>) {
  const response = z.record(z.unknown()).parse(await read(path, query));
  return z.array(z.unknown()).parse(response[key]);
}
export const scanSchema = z.object({
  office_code: z.string().min(1), fiscal_year: z.number().int(),
  start_date: date.optional(), end_date: date,
  audit_links: z.boolean().default(false),
  department_balances: z.boolean().default(false),
}).strict();
export type ScanInput = z.input<typeof scanSchema>;

export async function collect(raw: ScanInput, injected?: ReadApi): Promise<Snapshot> {
  const input = scanSchema.parse(raw);
  let apiCalls = 0;
  const read: ReadApi = injected ? async (path, query) => { apiCalls++; return injected(path, query); } :
    liveReader(input.office_code, () => { apiCalls++; });
  const started = new Date().toISOString();
  // Authenticate once before fan-out; the existing auth module caches the JWT.
  const terms = z.array(termSchema).parse(await list(read, "/term_settings", "term_settings"));
  const matches = terms.filter((t) => t.fiscal_year === input.fiscal_year);
  if (matches.length !== 1) throw new Error("Fiscal year must identify exactly one API term");
  const term = matches[0], start = input.start_date ?? term.start_date, end = input.end_date;
  if (start < term.start_date || end > term.end_date || start > end) throw new Error("Requested period outside fiscal term");
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > 365) throw new Error("Transaction period exceeds 366 days");
  const period = { start_date: start, end_date: end };
  const pending = z.array(transactionSchema).parse(await pages(read, "/transactions", "transactions", 500,
    { ...period, journalizing_statuses: ["none"] }));
  const base = {
    schema_version: 1 as const, office_code: input.office_code, term, start_date: start, end_date: end,
    started_at: started, pending,
  };
  if (!pending.length && !input.audit_links && !input.department_balances) return validateSnapshot({ ...base, completed_at: new Date().toISOString(),
    api_calls: apiCalls, detail_complete: false, transactions: [], journals: [], accounts: [], sub_accounts: [],
    connected_accounts: [], taxes: [], departments: [] });
  // The API forbids combining explicit dates with fiscal_year / month parameters.
  const trialQuery = { start_date: term.start_date, end_date: end, with_sub_accounts: true, include_tax: term.accounting_method === "TAX_INCLUDED" };
  const accountMaster = list(read, "/accounts", "accounts", { available: false });
  const subMaster = accountMaster.then(async (rows) => {
    // /accounts normally embeds the same sub-account master. Avoid an expensive duplicate GET.
    const embedded = z.array(z.object({ id: z.string(), sub_accounts: z.array(z.object({
      id: z.string(), name: z.string(), account_id: z.string(),
    }).passthrough()) }).passthrough()).safeParse(rows);
    if (!embedded.success) return list(read, "/sub_accounts", "sub_accounts");
    if (embedded.data.some((a) => a.sub_accounts.some((sub) => sub.account_id !== a.id)))
      throw new Error("Embedded sub-account belongs to a different parent account");
    return embedded.data.flatMap((a) => a.sub_accounts);
  });
  const [journals, transactions, accounts, subs, connections, taxes, departments, bs, pl] = await batch<unknown>([
    pages(read, "/journals", "journals", 10000, { start_date: term.start_date, end_date: term.end_date }),
    pages(read, "/transactions", "transactions", 500, period),
    accountMaster, subMaster, // The fallback /sub_accounts endpoint must omit available=false.
    list(read, "/connected_accounts", "connected_accounts"),
    list(read, "/taxes", "taxes"), list(read, "/departments", "departments"),
    read("/reports/trial_balance_bs", trialQuery), read("/reports/trial_balance_pl", trialQuery),
  ]);
  return validateSnapshot({ ...base, completed_at: new Date().toISOString(), api_calls: apiCalls,
    detail_complete: true, journals, transactions, accounts, sub_accounts: subs, connected_accounts: connections,
    taxes, departments, trial_balance: { bs, pl, end_date: end } });
}

export async function readJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Use an absolute file path on the MCP host");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function saveRun(outputDir: string, files: Record<string, unknown>) {
  if (!isAbsolute(outputDir)) throw new Error("output_dir must be absolute on the MCP host");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const dir = join(outputDir, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const saved: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    if (!/^[a-z_]+\.json$/.test(name)) throw new Error("Invalid artifact name");
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    saved[name] = path;
  }
  return saved;
}
export async function runScan(input: ScanInput, outputDir: string, configFile?: string, resumeCache?: string) {
  // Validate paths and configuration before contacting MF.
  if (!isAbsolute(outputDir)) throw new Error("output_dir must be absolute");
  const config = configFile ? configSchema.parse(await readJson(configFile)) : undefined;
  if (config && config.office_code !== input.office_code) throw new Error("Configuration belongs to a different office");
  const normalized = scanSchema.parse(input);
  const cacheDir = resumeCache ?? dirname((await saveRun(outputDir, { "collection.json": normalized }))["collection.json"]);
  let attempts = 0;
  const maxAge = z.coerce.number().int().min(1).max(3600000).parse(process.env.MF_BATCH_CACHE_MAX_AGE_MS ?? 300000);
  const cached = await cacheReader(liveReader(input.office_code, () => { attempts++; }), cacheDir, input, maxAge);
  let s: Snapshot;
  try { s = await collect(input, cached.read); }
  catch (e) { throw new Error(`${(e as Error).message}\nSuccessful reads saved at: ${cacheDir}\nResume this request with --resume-cache (MCP: resume_cache).`); }
  s.api_calls = attempts;
  s.read_cache = { directory: cacheDir, ...cached.stats };
  const report = reconcile(s, config);
  const files = await saveRun(outputDir, { "snapshot.json": s, "reconciliation.json": report,
    "candidate_verification_manifest.json": report.candidate_verification_manifest,
    ...(normalized.department_balances ? { "department_balances.json": departmentBalances(s) } : {}) });
  return { ...report.summary, office_code: s.office_code, start_date: s.start_date, end_date: s.end_date,
    api_calls: s.api_calls, reused_responses: cached.stats.reused_responses,
    elapsed_ms: Date.parse(s.completed_at) - Date.parse(s.started_at), files };
}
export async function runReconcile(snapshotFile: string, outputDir: string, configFile?: string) {
  const report = reconcile(await readJson(snapshotFile), configFile ? await readJson(configFile) : undefined);
  return { ...report.summary, files: await saveRun(outputDir, { "reconciliation.json": report,
    "candidate_verification_manifest.json": report.candidate_verification_manifest }) };
}

export const verificationSchema = z.object({
  office_code: z.string().min(1),
  department_balances: z.boolean().optional(),
  department_opening: departmentOpeningSchema.optional(),
  journal_ids: z.array(z.string().min(1)),
  expected_statuses: z.array(z.object({
    transaction_id: z.string().min(1), status: z.enum(["none", "excluded", "registered", "modified", "new_voucher_attached"]),
  }).strict()),
}).strict();
export async function verify(rawSnapshot: unknown, rawManifest: unknown, injected?: ReadApi) {
  const before = validateSnapshot(rawSnapshot), manifest = verificationSchema.parse(rawManifest);
  if (before.office_code !== manifest.office_code) throw new Error("Verification belongs to a different office");
  if (!before.detail_complete || !before.trial_balance) throw new Error("Verification requires a full baseline; scan with audit_links=true before processing");
  if (new Set(manifest.journal_ids).size !== manifest.journal_ids.length ||
      new Set(manifest.expected_statuses.map((r) => r.transaction_id)).size !== manifest.expected_statuses.length)
    throw new Error("Duplicate IDs in verification manifest");
  for (const id of manifest.journal_ids) if (!before.journals.some((j) => j.id === id)) throw new Error("Journal missing from baseline");
  for (const row of manifest.expected_statuses) if (!before.transactions.some((t) => t.id === row.transaction_id))
    throw new Error("Transaction missing from baseline");
  const checkDepartments = manifest.department_balances ?? (before.departments.length > 0 || before.journals.some((j) =>
    j.branches.some((b) => [b.debitor, b.creditor].some((side) => typeof side?.department_id === "string"))));
  const departmentsBefore = checkDepartments ? departmentBalances(before, manifest.department_opening) : null;
  const read: ReadApi = injected ?? liveReader(before.office_code);
  // Also checks that the accounting method has not changed since the baseline.
  const terms = z.array(termSchema).parse(await list(read, "/term_settings", "term_settings"));
  const termsNow = terms.filter((t) => t.fiscal_year === before.term.fiscal_year);
  if (termsNow.length !== 1 || differences(before.term, termsNow[0]).length) throw new Error("Fiscal settings changed since baseline");
  const query = { start_date: before.term.start_date,
    end_date: before.trial_balance.end_date, with_sub_accounts: true, include_tax: before.term.accounting_method === "TAX_INCLUDED" };
  // Bound GET concurrency; writes are intentionally not part of this utility.
  const journals: z.infer<typeof journalSchema>[] = [];
  for (let i = 0; i < manifest.journal_ids.length; i += 4) {
    const group = manifest.journal_ids.slice(i, i + 4);
    journals.push(...await batch(group.map(async (id) => {
      const response = z.object({ journal: journalSchema }).parse(await read(`/journals/${encodePathId(id)}`));
      if (response.journal.id !== id) throw new Error("Journal response ID mismatch");
      return response.journal;
    })));
  }
  const dates = manifest.expected_statuses.map((e) => before.transactions.find((t) => t.id === e.transaction_id)!.date).sort();
  const [pendingRaw, transactionsRaw, bs, pl, departmentJournals] = await batch<unknown>([
    pages(read, "/transactions", "transactions", 500, { start_date: before.start_date, end_date: before.end_date, journalizing_statuses: ["none"] }),
    dates.length ? pages(read, "/transactions", "transactions", 500, { start_date: dates[0], end_date: dates.at(-1) }) : Promise.resolve([]),
    read("/reports/trial_balance_bs", query), read("/reports/trial_balance_pl", query),
    checkDepartments ? pages(read, "/journals", "journals", 10000, { start_date: before.term.start_date, end_date: before.end_date }) : Promise.resolve(null),
  ]);
  const pending = z.array(transactionSchema).parse(pendingRaw);
  if (pending.some((t) => t.journalizing_status !== "none")) throw new Error("Non-pending transactions returned by pending filter");
  const transactions = z.array(transactionSchema).parse(transactionsRaw);
  const statuses = manifest.expected_statuses.map((e) => {
    const t = transactions.find((t) => t.id === e.transaction_id);
    return { ...e, actual: t?.journalizing_status ?? "missing", matches: t?.journalizing_status === e.status };
  });
  const transactionChanges = manifest.expected_statuses.flatMap((e) => {
    const original = before.transactions.find((t) => t.id === e.transaction_id)!;
    const current = transactions.find((t) => t.id === e.transaction_id);
    const changes = differences(original, current).filter((d) => d.path !== "/journalizing_status");
    return changes.length ? [{ transaction_id: e.transaction_id, changes }] : [];
  });
  const journalChanges = journals.map((j) => ({ journal_id: j.id, number: j.number,
    changes: differences(before.journals.find((b) => b.id === j.id)!, j)
      .filter((d) => d.path !== "/update_time") })).filter((r) => r.changes.length);
  const balances = { bs: reportDifferences(before.trial_balance.bs, bs), pl: reportDifferences(before.trial_balance.pl, pl) };
  const departmentsAfter = checkDepartments ? departmentBalances({ ...before, journals: departmentJournals }, manifest.department_opening) : null;
  const departmentChanges = checkDepartments ? differences(departmentsBefore!.rows, departmentsAfter!.rows) : [];
  return {
    office_code: before.office_code, checked_at: new Date().toISOString(),
    start_date: before.start_date, end_date: before.end_date,
    summary: {
      pending: pending.length,
      checked_journals: journals.length, statuses_match: statuses.every((s) => s.matches),
      selected_transaction_details_unchanged: !transactionChanges.length,
      selected_journals_unchanged: !journalChanges.length, trial_balances_unchanged: !balances.bs.length && !balances.pl.length,
      changed_journals: journalChanges.length, balance_changes: balances.bs.length + balances.pl.length,
      department_balances_checked: checkDepartments,
      department_balances_unchanged: checkDepartments ? !departmentChanges.length : null,
      department_balance_changes: departmentChanges.length,
    },
    note: "Changes require comparison with the authorized entries. Unchanged trial balances do not establish agreement with bank balances.",
    statuses, transaction_changes: transactionChanges, journal_changes: journalChanges, balance_changes: balances, journals, transactions, pending, trial_balance: { bs, pl },
    department_balances: checkDepartments ? { before: departmentsBefore, after: departmentsAfter, changes: departmentChanges } : null,
  };
}
export async function runVerify(snapshotFile: string, manifestFile: string, outputDir: string) {
  if (!isAbsolute(outputDir)) throw new Error("output_dir must be absolute");
  const result = await verify(await readJson(snapshotFile), await readJson(manifestFile));
  return { ...result.summary, files: await saveRun(outputDir, { "verification.json": result }) };
}

export async function runDepartments(snapshotFile: string, outputDir: string, openingFile?: string) {
  const result = departmentBalances(await readJson(snapshotFile), openingFile ? await readJson(openingFile) : undefined);
  return { ...result.summary, files: await saveRun(outputDir, { "department_balances.json": result }) };
}

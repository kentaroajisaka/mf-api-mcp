import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { differences, gross, normalize, reconcile, reportDifferences, validateSnapshot } from "../dist/bookkeeping.js";
import { cacheReader, collect, pages, retryRead, saveRun, verify } from "../dist/bookkeeping-runner.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { departmentBalances } from "../dist/department-balances.js";
import { cloudBoxFileUrls, memoEvidenceUrls } from "../dist/evidence-urls.js";

// Synthetic fixtures. No real customer, account, date, receipt or credential is used.
const term = { fiscal_year: 2034, start_date: "2034-04-01", end_date: "2035-03-31", accounting_method: "TAX_INCLUDED" };
const transaction = (extra = {}) => ({
  id: "transaction-a", date: "2034-05-20", value: 290, side: "EXPENSE", content: "サンプル商店",
  connected_account_id: "connection-a", connected_sub_account_id: "card-a", journalizing_status: "none", voucher_file_ids: [], ...extra,
});
const journal = (extra = {}) => ({
  id: "journal-a", number: 1, transaction_date: "2034-05-20", journal_type: "journal_entry", transaction_id: null,
  update_time: "2034-05-20T01:00:00Z", voucher_file_ids: [], memo: "既存メモ", tags: [],
  branches: [{ debitor: { account_id: "expense", account_name: "例示費", value: 264, tax_value: 26 },
    creditor: { account_id: "settlement", account_name: "例示未払", sub_account_id: "sub-a", value: 290, tax_value: 0 }, remark: "サンプル商店" }], ...extra,
});
const fixture = () => ({
  schema_version: 1, office_code: "test-office-a", term, start_date: term.start_date, end_date: "2034-05-31",
  started_at: "2034-06-01T00:00:00Z", completed_at: "2034-06-01T00:00:01Z", detail_complete: true, api_calls: 11,
  pending: [transaction()], transactions: [transaction()], journals: [journal()],
  accounts: [{ id: "expense", name: "例示費" }, { id: "settlement", name: "例示未払" }, { id: "migration", name: "移行先" }],
  sub_accounts: [{ id: "sub-a", name: "テストカード", account_id: "settlement" }],
  connected_accounts: [{ id: "connection-a", name: "例示サービス", connected_sub_accounts: [{ id: "card-a", name: "利用者A", account_id: "settlement", sub_account_id: "sub-a" }] }],
  taxes: [], departments: [], trial_balance: { end_date: "2034-05-31", bs: { rows: [{ id: "settlement", balance: 290 }] }, pl: { rows: [{ id: "expense", balance: 290 }] } },
});
const paged = (rows, limit) => ({ metadata: { total_count: rows.length, total_pages: Math.ceil(rows.length / limit) },
  [limit === 10000 ? "journals" : "transactions"]: rows });

test("unique same-date gross settlement and content match includes Dr/Cr and evidence status", () => {
  const s = fixture(), r = reconcile(s);
  assert.equal(gross(s.journals[0].branches[0].debitor), 290);
  assert.equal(r.summary.matched_candidates, 1);
  assert.equal(r.items[0].candidates[0].branches[0].debitor.gross_value, 290);
  assert.equal(r.items[0].candidates[0].evidence_status, "attachment_absent_other_sources_unchecked");
});
test("wrong direction, different card or different content never matches", () => {
  for (const change of [ { side: "INCOME" }, { connected_sub_account_id: "other-card" }, { content: "別の商店" }, { content: null } ]) {
    const s = fixture(); s.pending = s.transactions = [transaction(change)];
    assert.equal(reconcile(s).summary.matched_candidates, 0);
  }
  assert.equal(normalize("ＥＴＣ　支社"), normalize("ETC 支社"));
  assert.notEqual(normalize("店123"), normalize("店124"));
  assert.notEqual(normalize("AB-C"), normalize("ABC"));
});
test("two equal journals are ambiguous and one journal cannot serve two transactions", () => {
  const twoJournals = fixture(); twoJournals.journals.push(journal({ id: "journal-b", number: 2 }));
  assert.equal(reconcile(twoJournals).summary.matched_candidates, 0);
  const twoTransactions = fixture(); twoTransactions.transactions.push(transaction({ id: "transaction-b" }));
  twoTransactions.pending = [...twoTransactions.transactions];
  const r = reconcile(twoTransactions);
  assert.equal(r.summary.review, 2);
  assert(r.items.every((i) => i.reasons.includes("journal_claimed_by_multiple_transactions")));
});
test("a matching net total cannot hide a different merchant inside a compound journal", () => {
  const s = fixture();
  s.journals[0].branches[0].creditor.value = 150;
  s.journals[0].branches.push({ debitor: null, creditor: { account_id: "settlement", sub_account_id: "sub-a", value: 140, tax_value: 0 }, remark: "別の商店" });
  assert.equal(reconcile(s).summary.matched_candidates, 0);
});
test("a feed-linked journal is not reused; linked content mismatch is separately reported", () => {
  const s = fixture(); s.journals[0].transaction_id = "registered-feed";
  s.transactions.push(transaction({ id: "registered-feed", content: "道路料金", journalizing_status: "registered" }));
  const r = reconcile(s);
  assert.equal(r.summary.pending, 1); assert.equal(r.summary.matched_candidates, 0);
  assert.equal(r.linked_issues[0].transaction.journalizing_status, "registered");
  assert(r.linked_issues[0].reasons.includes("linked_content_mismatch"));
});
test("runtime bindings and exact aliases resolve against masters; foreign office is rejected", () => {
  const s = fixture(); s.journals[0].branches[0].creditor.account_id = "migration";
  s.journals[0].branches[0].creditor.sub_account_id = null;
  s.journals[0].branches[0].remark = "旧表記サンプル";
  const config = { office_code: s.office_code,
    bindings: [{ connected_account_id: "connection-a", connected_sub_account_id: "card-a", account: { name: "移行先" }, sub_account: null, reason: "確認済み移行先" }],
    content_aliases: [{ connected_account_id: "connection-a", connected_sub_account_id: "card-a", transaction_content: "サンプル商店", journal_remark: "旧表記サンプル", reason: "表記差を確認" }],
  };
  assert.equal(reconcile(s, config).summary.matched_candidates, 1);
  assert.throws(() => reconcile(s, { ...config, office_code: "test-office-b" }), /different office/);
  s.accounts.push({ id: "other", name: "移行先" });
  assert.equal(reconcile(s, config).summary.matched_candidates, 0);
});
test("snapshot rejects wrong period, duplicated IDs and changing pending membership", () => {
  const s = fixture(); s.pending.push(transaction());
  assert.throws(() => validateSnapshot(s), /Duplicate/);
  const changed = fixture(); changed.transactions[0].journalizing_status = "excluded";
  assert.throws(() => validateSnapshot(changed), /changed during collection/);
  assert.throws(() => validateSnapshot({ ...fixture(), start_date: "2034-02-30" }));
});
test("zero pending costs two reads and fiscal start comes from API, even for non-January terms", async () => {
  const calls = [];
  const s = await collect({ office_code: "test-office-b", fiscal_year: term.fiscal_year, end_date: "2034-05-31" }, async (path, query) => {
    calls.push({ path, query });
    if (path === "/term_settings") return { term_settings: [term] };
    assert.equal(path, "/transactions"); assert.equal(query.start_date, "2034-04-01");
    assert.equal(query.per_page, 500); assert.deepEqual(query.journalizing_statuses, ["none"]);
    return paged([], 500);
  });
  assert.equal(s.api_calls, 2); assert.equal(s.office_code, "test-office-b"); assert.equal(s.detail_complete, false);
  assert.equal(reconcile(s).summary.pending, 0); assert.equal(calls.length, 2);
});
function reader(s, calls = []) {
  return async (path, query) => {
    calls.push({ path, query });
    if (path === "/term_settings") return { term_settings: [s.term] };
    if (path === "/transactions") return paged(query.journalizing_statuses ? s.pending : s.transactions, 500);
    if (path === "/journals") { assert.equal(query.per_page, 10000); return paged(s.journals, 10000); }
    if (path.startsWith("/journals/")) return { journal: s.journals.find((j) => encodeURIComponent(j.id) === path.slice("/journals/".length)) };
    if (path.startsWith("/reports/")) {
      assert.equal(query.fiscal_year, undefined); assert.equal(query.start_date, term.start_date);
      return path.endsWith("_bs") ? s.trial_balance.bs : s.trial_balance.pl;
    }
    const key = path.slice(1);
    if (key === "sub_accounts") assert.equal(query, undefined);
    assert(key in s, `Unexpected API path ${path}`);
    return { [key]: s[key] };
  };
}
test("full collection uses one annual journal request, caches masters and both balances", async () => {
  const calls = [], s = fixture();
  const got = await collect({ office_code: s.office_code, fiscal_year: term.fiscal_year, end_date: s.end_date }, reader(s, calls));
  assert.equal(got.detail_complete, true); assert.equal(got.journals.length, 1);
  assert.equal(calls.filter((c) => c.path === "/journals").length, 1);
  assert.equal(calls.find((c) => c.path === "/journals").query.end_date, term.end_date);
  assert.deepEqual(got.trial_balance, s.trial_balance);
});
test("audit_links forces a full baseline when pending is zero", async () => {
  const s = fixture(); s.pending = []; s.transactions[0].journalizing_status = "excluded";
  const got = await collect({ office_code: s.office_code, fiscal_year: term.fiscal_year, end_date: s.end_date, audit_links: true }, reader(s));
  assert.equal(got.detail_complete, true); assert.equal(got.journals.length, 1);
});
test("embedded sub-account masters are reused without a duplicate API request", async () => {
  const s = fixture(), calls = [];
  s.accounts = s.accounts.map((a) => ({ ...a, sub_accounts: s.sub_accounts.filter((sub) => sub.account_id === a.id) }));
  const got = await collect({ office_code: s.office_code, fiscal_year: term.fiscal_year, end_date: s.end_date }, reader(s, calls));
  assert.deepEqual(got.sub_accounts, s.sub_accounts);
  assert.equal(calls.filter((c) => c.path === "/sub_accounts").length, 0);
});
test("pagination reads remaining pages and fails closed on duplicates, count drift and truncated pages", async () => {
  const read = async (_, q) => ({ metadata: { total_count: 3, total_pages: 2 }, rows: q.page === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }] });
  assert.equal((await pages(read, "/test", "rows", 2)).length, 3);
  for (const bad of [
    async (_, q) => ({ metadata: { total_count: 3, total_pages: 2 }, rows: q.page === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "a" }] }),
    async (_, q) => ({ metadata: { total_count: q.page === 1 ? 3 : 4, total_pages: 2 }, rows: [{ id: "a" }, { id: "b" }] }),
    async () => ({ metadata: { total_count: 3, total_pages: 2 }, rows: [{ id: "a" }] }),
  ]) await assert.rejects(pages(bad, "/test", "rows", 2));
});
test("read-only retries recover once from a network failure but never retry 4xx or validation errors", async () => {
  let calls = 0;
  assert.deepEqual(await retryRead(async () => { if (!calls++) throw new TypeError("fetch failed"); return { ok: true }; })("/test"), { ok: true });
  assert.equal(calls, 2);
  for (const error of [new Error("HTTP 400 invalid account"), new Error("HTTP 429 wait"), new Error("invalid JSON")]) {
    calls = 0;
    await assert.rejects(retryRead(async () => { calls++; throw error; })("/test"), /GET \/test/);
    assert.equal(calls, 1);
  }
});
test("balance diff ignores row order and shows numeric changes with account identity", () => {
  const before = [{ id: "a", balance: 100 }, { id: "b", balance: 200 }];
  assert.deepEqual(differences(before, [...before].reverse()), []);
  assert.deepEqual(differences(before, [{ id: "b", balance: 350 }, before[0]]), [{ path: "/b/balance", before: 200, after: 350, delta: 150 }]);
  assert.deepEqual(reportDifferences({ created_at: "first", rows: before }, { created_at: "second", rows: [...before].reverse() }), []);
  assert.equal(reportDifferences({ created_at: "first", balance: 100 }, { created_at: "second", balance: 250 })[0].delta, 150);
});
test("verification reads only selected journals, checks statuses and exposes account/balance changes", async () => {
  const before = fixture(), after = structuredClone(before), calls = [];
  after.transactions[0].journalizing_status = "excluded"; after.pending = [];
  after.journals[0].branches[0].debitor.account_id = "migration";
  after.trial_balance.bs.rows[0].balance += 150;
  const result = await verify(before, { office_code: before.office_code, journal_ids: ["journal-a"], expected_statuses: [{ transaction_id: "transaction-a", status: "excluded" }] }, reader(after, calls));
  assert.equal(result.summary.pending, 0); assert.equal(result.summary.statuses_match, true);
  assert.equal(result.summary.selected_transaction_details_unchanged, true);
  assert.equal(result.summary.selected_journals_unchanged, false); assert.equal(result.summary.trial_balances_unchanged, false);
  assert.equal(result.balance_changes.bs[0].delta, 150);
  assert.equal(calls.filter((c) => c.path === "/journals").length, 0);
  assert.equal(calls.filter((c) => c.path.startsWith("/journals/")).length, 1);
  const targetRead = calls.find((c) => c.path === "/transactions" && !c.query.journalizing_statuses);
  assert.equal(targetRead.query.start_date, before.transactions[0].date);
  assert.equal(targetRead.query.end_date, before.transactions[0].date);
});
test("verification rejects foreign-office manifests and missing baseline journals before any API call", async () => {
  const s = fixture(); const never = async () => { throw new Error("Unexpected API call"); };
  await assert.rejects(verify(s, { office_code: "test-office-b", journal_ids: [], expected_statuses: [] }, never), /different office/);
  await assert.rejects(verify(s, { office_code: s.office_code, journal_ids: ["missing"], expected_statuses: [] }, never), /missing from baseline/);
});
function departmentalFixture() {
  const s = fixture();
  s.departments = [{ id: "dept-a", name: "例示本部", parent_id: null }, { id: "dept-b", name: "例示園", parent_id: "dept-a" }];
  s.accounts[0].account_group = "EXPENSE"; s.accounts[1].account_group = "LIABILITY";
  s.journals[0].is_realized = true;
  s.journals[0].branches[0].debitor.department_id = "dept-b";
  s.journals[0].branches[0].creditor.department_id = "dept-a";
  return s;
}
test("department aggregation uses each side's ID, keeps unassigned and does not double count parent/child", () => {
  const s = departmentalFixture();
  const r = departmentBalances(s);
  assert.equal(r.rows.find((r) => r.department_id === "dept-b").debit_amount, 290);
  assert.equal(r.rows.find((r) => r.department_id === "dept-a").credit_amount, 290);
  assert.equal(r.rows.find((r) => r.department_id === "dept-b").closing_balance, null);
  assert.equal(r.rows.reduce((n, r) => n + r.debit_amount, 0), 290);
  s.journals[0].branches[0].creditor.department_id = null;
  assert.equal(departmentBalances(s).rows.find((r) => r.department_id === null).credit_amount, 290);
});
test("known departmental opening balances produce credit/debit-normal closing balances and enforce scope", () => {
  const s = departmentalFixture();
  const opening = {office_code:s.office_code,fiscal_year:term.fiscal_year,as_of_date:"2034-03-31",basis:"gross",source:"Synthetic department opening ledger",rows:[{
    department_id:"dept-a",account_id:"settlement",sub_account_id:"sub-a",opening_debit_minus_credit:-100,
  }]};
  assert.equal(departmentBalances(s,opening).rows.find((r) => r.department_id === "dept-a").closing_balance,390);
  assert.throws(() => departmentBalances(s,{...opening,office_code:"other-office"}),/different office/);
  assert.throws(() => departmentBalances(s,{...opening,rows:[...opening.rows,...opening.rows]}),/Duplicate/);
});
test("department verification detects reassignment while whole-company balances stay unchanged", async () => {
  const before = departmentalFixture(), after = structuredClone(before), calls = [];
  after.journals[0].branches[0].debitor.department_id = "dept-a";
  const result = await verify(before,{office_code:before.office_code,journal_ids:[],expected_statuses:[]},reader(after,calls));
  assert.equal(result.summary.trial_balances_unchanged,true);
  assert.equal(result.summary.department_balances_checked,true);
  assert.equal(result.summary.department_balances_unchanged,false);
  assert(result.department_balances.changes.length > 0);
  assert.equal(calls.filter((c) => c.path === "/journals").length,1);
});
test("department totals exclude unrealized journals and refuse missing realization/department metadata", () => {
  const s = departmentalFixture(); s.journals[0].is_realized = false;
  assert.equal(departmentBalances(s).summary.excluded_unrealized,1);
  delete s.journals[0].is_realized;
  assert.throws(() => departmentBalances(s),/realization status/);
  s.journals[0].is_realized = true; delete s.journals[0].branches[0].debitor.department_id;
  assert.throws(() => departmentBalances(s),/department_id is missing/);
});
test("department request overrides zero-pending fast path", async () => {
  const s = departmentalFixture();s.pending=[];s.transactions[0].journalizing_status="excluded";
  const got=await collect({office_code:s.office_code,fiscal_year:term.fiscal_year,end_date:s.end_date,department_balances:true},reader(s));
  assert.equal(got.detail_complete,true);assert.equal(got.journals.length,1);
});
test("evidence URLs distinguish browser-session download from OAuth download and parse only memo detail URLs", () => {
  const id="11111111-1111-4111-8111-111111111111";
  const urls=cloudBoxFileUrls(id);
  assert.equal(urls.web_download_url,`https://box.moneyforward.com/frontend/v3/files/${id}/download`);
  assert.notEqual(urls.web_download_url,urls.api_download_url);
  assert.equal(memoEvidenceUrls(`証憑: ${urls.detail_url}\n${urls.detail_url}`).length,1);
  assert.equal(memoEvidenceUrls(`https://example.com/files/${id}`).length,0);
  assert.throws(() => cloudBoxFileUrls("../other"));
});
test("artifacts get a private run directory and private files without overwriting existing runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-bookkeeping-test-"));
  try {
    const a = await saveRun(root, { "snapshot.json": { sample: true } });
    const b = await saveRun(root, { "snapshot.json": { sample: false } });
    assert.notEqual(a["snapshot.json"], b["snapshot.json"]);
    assert.equal((await stat(a["snapshot.json"])).mode & 0o777, 0o600);
    assert.equal((await stat(join(a["snapshot.json"], ".."))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(a["snapshot.json"], "utf8")), { sample: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("resuming a failed collection reuses only successful reads with the same office and period", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-read-cache-test-"));
  const scope = { office_code: "test-office-a", fiscal_year: term.fiscal_year, end_date: "2034-05-31", audit_links: false };
  try {
    const files = await saveRun(root, { "collection.json": scope });
    const dir = join(files["collection.json"], "..");
    let calls = 0;
    const first = await cacheReader(async (path) => { calls++; if (path === "/failed") throw new Error("HTTP 503"); return { rows: [] }; }, dir, scope);
    await first.read("/success", { page: 1 }); await assert.rejects(first.read("/failed"));
    const second = await cacheReader(async () => { calls++; return { recovered: true }; }, dir, scope);
    assert.deepEqual(await second.read("/success", { page: 1 }), { rows: [] });
    assert.deepEqual(await second.read("/failed"), { recovered: true });
    assert.equal(calls, 3); assert.equal(second.stats.reused_responses, 1);
    await assert.rejects(cacheReader(async () => ({}), dir, { ...scope, office_code: "test-office-b" }), /different office/);
    const fresh = await cacheReader(async () => ({ fresh: true }), dir, scope, -1);
    assert.deepEqual(await fresh.read("/success", { page: 1 }), { fresh: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("MCP exposes shared batches and zero-pending scan works through the MCP client", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.MF_API_KEY;
  const dir = await mkdtemp(join(tmpdir(), "mf-mcp-batch-test-"));
  const server = createServer(), client = new Client({ name: "batch-test", version: "1" });
  try {
    process.env.MF_API_KEY = "synthetic-key";
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/auth/exchange")) return Response.json({ access_token: "synthetic-jwt", expires_in: 3600 });
      const u = new URL(url); assert.equal(u.searchParams.get("office_code"), "test-office-b"); assert.equal(init.method, "GET");
      if (u.pathname.endsWith("/term_settings")) return Response.json({ term_settings: [term] });
      assert(u.pathname.endsWith("/transactions")); return Response.json(paged([], 500));
    };
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["mf_bookkeeping_scan", "mf_bookkeeping_reconcile", "mf_bookkeeping_verify"]) assert(names.includes(name));
    const r = await client.callTool({ name: "mf_bookkeeping_scan", arguments: { office_code: "test-office-b", fiscal_year: 2034, end_date: "2034-05-31", output_dir: dir } });
    assert.equal(r.isError, undefined, JSON.stringify(r)); assert.equal(JSON.parse(r.content[0].text).pending, 0);
  } finally {
    await client.close(); await server.close(); globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MF_API_KEY; else process.env.MF_API_KEY = originalKey;
    await rm(dir, { recursive: true, force: true });
  }
});

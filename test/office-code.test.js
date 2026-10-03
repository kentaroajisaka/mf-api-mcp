import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

const explicitOffice = "3333-4444";
const defaultOffice = "1111-2222";
const apiBase = "https://api-accounting.moneyforward.com/api/v3";
const exchangeUrl = "https://api.biz.moneyforward.com/auth/exchange";

const toolCases = [
  ["mfc_ca_getAccounts", "GET", "/accounts", { available: false }],
  ["mfc_ca_getSubAccounts", "GET", "/sub_accounts", { available: false }],
  ["mfc_ca_getDepartments", "GET", "/departments", { available: false }],
  ["mfc_ca_getTaxes", "GET", "/taxes", { available: false }],
  ["mfc_ca_getTradePartners", "GET", "/trade_partners", { available: false }],
  ["mfc_ca_currentOffice", "GET", "/offices", {}],
  ["mfc_ca_getTermSettings", "GET", "/term_settings", {}],
  ["mfc_ca_postTradePartners", "POST", "/trade_partners", { trade_partner: { name: "test" } }],
  ["mfc_ca_getConnectedAccounts", "GET", "/connected_accounts", {}],
  ["mfc_ca_getJournals", "GET", "/journals", { start_date: "2026-09-01" }],
  ["mfc_ca_getJournalById", "GET", "/journals/test-id", { id: "test-id" }],
  ["mfc_ca_postJournals", "POST", "/journals", { journal: { journal_type: "journal_entry" } }],
  ["mfc_ca_putJournals", "PUT", "/journals/test-id", { id: "test-id", journal: { journal_type: "journal_entry" } }],
  ["mfc_ca_deleteJournals", "DELETE", "/journals/test-id", { id: "test-id" }],
  ["mfc_ca_getReportsTrialBalanceBalanceSheet", "GET", "/reports/trial_balance_bs", {}],
  ["mfc_ca_getReportsTrialBalanceProfitLoss", "GET", "/reports/trial_balance_pl", {}],
  ["mfc_ca_getReportsTransitionBalanceSheet", "GET", "/reports/transition_bs", { type: "monthly" }],
  ["mfc_ca_getReportsTransitionProfitLoss", "GET", "/reports/transition_pl", { type: "monthly" }],
  ["mfc_ca_getTransactions", "GET", "/transactions", { start_date: "2026-09-01", end_date: "2026-09-02" }],
  ["mfc_ca_postTransactions", "POST", "/transactions", {
    connected_account_id: "test-account",
    transactions: [{ date: "2026-09-01", value: 1, side: "INCOME", content: "test" }],
  }],
  ["mfc_ca_postTransactionJournalize", "POST", "/transactions/journalize", { transaction_id: "test-id", account_id: "test-account" }],
  ["mfc_ca_postVouchers", "POST", "/vouchers", { voucher_files: [{ file_name: "test.txt", file_data: "dGVzdA==" }] }],
  ["mfc_ca_deleteVouchers", "DELETE", "/vouchers", { journal_id: "test-id", voucher_file_id: "test-file" }],
];

let client;
let server;
let originalFetch;
let originalApiKey;
let originalOfficeCode;
const apiRequests = [];

before(async () => {
  originalFetch = globalThis.fetch;
  originalApiKey = process.env.MF_API_KEY;
  originalOfficeCode = process.env.MF_OFFICE_CODE;
  process.env.MF_API_KEY = "test-api-key";
  delete process.env.MF_OFFICE_CODE;

  // API キー交換も会計 API も通信しない。想定外の URL は即失敗させる。
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === exchangeUrl) {
      assert.equal(init?.method, "POST");
      return Response.json({ access_token: "test-jwt", expires_in: 3600 });
    }
    if (url.startsWith(`${apiBase}/`)) {
      apiRequests.push({ url: new URL(url), method: init?.method });
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = createServer();
  client = new Client({ name: "office-code-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await server?.close();
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.MF_API_KEY;
  else process.env.MF_API_KEY = originalApiKey;
  if (originalOfficeCode === undefined) delete process.env.MF_OFFICE_CODE;
  else process.env.MF_OFFICE_CODE = originalOfficeCode;
});

async function checkTool(name, method, path, args, expectedOffice) {
  apiRequests.length = 0;
  const result = await client.callTool({ name, arguments: { ...args, ...(expectedOffice === explicitOffice ? { office_code: explicitOffice } : {}) } });
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.content)}`);
  assert.equal(apiRequests.length, 1, `${name}: expected one accounting API request`);
  const request = apiRequests[0];
  assert.equal(request.method, method);
  assert.equal(request.url.pathname, `/api/v3${path}`);
  assert.equal(request.url.searchParams.get("office_code"), expectedOffice);
  if (Object.hasOwn(args, "available")) {
    assert.equal(request.url.searchParams.get("available"), "false");
  }
}

test("office_code を受け取る登録済みツールをすべて点検対象に含める", async () => {
  const { tools } = await client.listTools();
  const actual = tools.filter(({ name }) => name.startsWith("mfc_ca_")).map(({ name }) => name).sort();
  assert.deepEqual(actual, toolCases.map(([name]) => name).sort());
  for (const tool of tools.filter(({ name }) => name.startsWith("mfc_ca_"))) {
    assert.ok(tool.inputSchema.properties?.office_code, `${tool.name}: office_code missing from schema`);
  }
});

for (const [name, method, path, args] of toolCases) {
  test(`${name}: 引数の office_code が API URL に届く`, async () => {
    await checkTool(name, method, path, args, explicitOffice);
  });
}

test("MF_OFFICE_CODE は引数省略時に使われる", async () => {
  process.env.MF_OFFICE_CODE = defaultOffice;
  try {
    await checkTool("mfc_ca_getAccounts", "GET", "/accounts", { available: false }, defaultOffice);
  } finally {
    delete process.env.MF_OFFICE_CODE;
  }
});

test("引数の office_code は MF_OFFICE_CODE より優先される", async () => {
  process.env.MF_OFFICE_CODE = defaultOffice;
  try {
    await checkTool("mfc_ca_getAccounts", "GET", "/accounts", { available: false }, explicitOffice);
  } finally {
    delete process.env.MF_OFFICE_CODE;
  }
});

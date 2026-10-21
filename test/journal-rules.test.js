import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerJournalRuleTools, toWritableRule } from "../dist/journal-rules.js";

// GET /journal_rules が返す形（2026-10-21 実データの形。ID と名前は試験用）
const sideGet = (account, valueType, extra = {}) => ({
  account_id: account, account_name: "科目", sub_account_id: null, sub_account_name: null,
  tax_id: "tax", tax_name: "対象外", tax_long_name: "対象外", department_id: "dep", department_name: "本部",
  invoice_kind: "INVOICE_KIND_NOT_TARGET", trade_partner_code: null, trade_partner_name: null,
  value: null, value_type: valueType, ...extra,
});
const ruleGet = {
  id: "rule-1", connected_account_id: "ca", connected_sub_account_id: "csa", side: "EXPENSE",
  is_fallback_rule: false, is_auto_registration: false, content: "コウセイホケン",
  condition_content_match_type: "exact", value_min: null, value_max: null, priority: 100,
  journal_template: { tags: [], branches: [
    { remark: null, debitor: sideGet("expense", "ORIGINAL_AMOUNT"), creditor: sideGet("bank", "ORIGINAL_AMOUNT") },
    { remark: "固定", debitor: sideGet("fee", "FIXED_AMOUNT", { value: 330 }), creditor: null },
  ] },
};

test("GET の形を PUT で送れる形に直し、読んだ値を落とさない", () => {
  const w = toWritableRule(ruleGet, true);
  assert.equal(w.id, "rule-1");
  assert.equal(w.is_fallback_rule, false);
  assert.equal(w.priority, 100);
  assert.equal(w.content, "コウセイホケン");
  assert.equal(w.condition_content_match_type, "exact");
  assert.equal(w.is_auto_registration, false);
  assert.deepEqual(w.journal_template.tags, []);
  const [b1, b2] = w.journal_template.branches;
  assert.equal(b1.remark, null);
  assert.equal(b1.debitor.account_id, "expense");
  assert.equal(b1.debitor.department_id, "dep");
  assert.equal(b1.debitor.invoice_kind, "INVOICE_KIND_NOT_TARGET");
  assert.ok(!("account_name" in b1.debitor), "名前は送らない");
  assert.ok(!("value" in b1.debitor), "ORIGINAL_AMOUNT では value を送らない");
  assert.equal(b2.debitor.value, 330, "FIXED_AMOUNT は value を送る");
  assert.ok(!("creditor" in b2), "空の側は送らない");
});

test("POST では id を送らない", () => {
  const w = toWritableRule(ruleGet, false);
  assert.ok(!("id" in w));
});

test("どのルールにもマッチしなかった場合のルールは content・優先度を送らない", () => {
  const fb = { ...ruleGet, is_fallback_rule: true, content: null, condition_content_match_type: null, priority: null };
  const w = toWritableRule(fb, true);
  assert.equal(w.is_fallback_rule, true);
  for (const k of ["content", "condition_content_match_type", "value_min", "value_max", "priority"]) assert.ok(!(k in w), k);
});

test("all_pages は最後のページまで取って結合する", async () => {
  const calls = [];
  const call = async (method, path, opts) => {
    calls.push({ method, path, ...opts });
    const page = opts.query.page;
    return JSON.stringify({ journal_rules: [{ id: `r${page}` }], metadata: { total_count: 3, total_pages: 3 } });
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerJournalRuleTools(server, call, { office_code: z.string().optional() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await server.connect(st);
  await client.connect(ct);
  const r = await client.callTool({ name: "mfc_ca_getJournalRules", arguments: { office_code: "1111-2222", side: "EXPENSE", all_pages: true } });
  const body = JSON.parse(r.content[0].text);
  assert.deepEqual(body.journal_rules.map((x) => x.id), ["r1", "r2", "r3"]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.query.per_page === 200 && c.query.side === "EXPENSE" && c.officeCode === "1111-2222"));
  assert.ok(calls.every((c) => !("all_pages" in c.query)));
  const put = await client.callTool({ name: "mfc_ca_putJournalRules", arguments: { office_code: "1111-2222", journal_rules: [{ side: "EXPENSE" }] } });
  assert.equal(put.isError, true, "id の無い更新は送らない");
  await client.close();
  await server.close();
});

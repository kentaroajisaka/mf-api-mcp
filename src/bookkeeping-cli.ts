#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDepartments, runReconcile, runScan, runVerify } from "./bookkeeping-runner.js";

const usage = `Read-only MF bookkeeping batches (authentication uses the existing mf-api key).
scan --office OFFICE --fiscal-year YEAR --end YYYY-MM-DD --output-dir ABS_DIR [--start YYYY-MM-DD] [--audit-links] [--department-balances] [--config ABS_JSON] [--resume-cache ABS_DIR]
reconcile --snapshot ABS_JSON --output-dir ABS_DIR [--config ABS_JSON]
verify --snapshot ABS_JSON --manifest ABS_JSON --output-dir ABS_DIR
departments --snapshot ABS_JSON --output-dir ABS_DIR [--opening ABS_JSON]
No accounting data is written. Review candidate reports before UI exclusion or journal updates.
All local paths refer to this host. No office, date, account, or exception is embedded in this program.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    office: { type: "string" }, "fiscal-year": { type: "string" }, start: { type: "string" }, end: { type: "string" },
    "output-dir": { type: "string" }, config: { type: "string" }, snapshot: { type: "string" }, manifest: { type: "string" },
    "resume-cache": { type: "string" },
    "department-balances": { type: "boolean" }, opening: { type: "string" },
    "audit-links": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); }
  else {
    const command = positionals[0];
    if (positionals.length !== 1 || !["scan", "reconcile", "verify", "departments"].includes(command)) throw new Error(usage);
    const allowed: Record<string, string[]> = {
      scan: ["office", "fiscal-year", "start", "end", "output-dir", "audit-links", "department-balances", "config", "resume-cache"],
      reconcile: ["snapshot", "output-dir", "config"], verify: ["snapshot", "manifest", "output-dir"],
      departments: ["snapshot", "output-dir", "opening"],
    };
    for (const key of Object.keys(values)) if (!allowed[command].includes(key)) throw new Error(`--${key} is not used by ${command}`);
    const required = (key: keyof typeof values): string => {
      const v = values[key]; if (typeof v !== "string" || !v.trim()) throw new Error(`Missing --${key}`); return v;
    };
    const output = required("output-dir");
    const result = command === "scan" ? await runScan({
      office_code: required("office"), fiscal_year: Number(required("fiscal-year")),
      start_date: values.start, end_date: required("end"), audit_links: values["audit-links"],
      department_balances: values["department-balances"],
    }, output, values.config, values["resume-cache"]) : command === "reconcile" ?
      await runReconcile(required("snapshot"), output, values.config) : command === "verify" ?
      await runVerify(required("snapshot"), required("manifest"), output) :
      await runDepartments(required("snapshot"), output, values.opening);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1;
}

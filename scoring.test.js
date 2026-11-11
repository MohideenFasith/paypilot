import test from "node:test";
import assert from "node:assert/strict";
import { scoreInvoice } from "../server.js";

test("high-risk overdue invoice gets firm two-part plan", () => {
  const result = scoreInvoice({ amount: 9000, daysOverdue: 80, relationship: "new", history: "late" });
  assert.ok(result.risk >= 70);
  assert.equal(result.tone, "firm");
  assert.deepEqual(result.plan, [50, 50]);
});

test("trusted current client gets warm full-payment reminder", () => {
  const result = scoreInvoice({ amount: 800, daysOverdue: 5, relationship: "long-term", history: "reliable" });
  assert.ok(result.risk < 40);
  assert.equal(result.tone, "warm");
  assert.deepEqual(result.plan, [100]);
});

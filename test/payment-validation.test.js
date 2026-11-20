import assert from "node:assert/strict";
import test from "node:test";

import { validatePaidInvoice } from "../lib/payment-validation.js";

test("extracts paid invoice amounts without changing their currency units", () => {
  assert.deepEqual(
    validatePaidInvoice({
      id: "in_test123",
      status: "paid",
      amount_paid: 1500,
      currency: "USD",
    }),
    {
      data: {
        invoiceId: "in_test123",
        amountMinor: 1500,
        currency: "usd",
      },
    },
  );
});

test("does not create revenue for unpaid or zero-value invoices", () => {
  assert.deepEqual(
    validatePaidInvoice({
      id: "in_open",
      status: "open",
      amount_paid: 0,
      currency: "usd",
    }),
    { data: null },
  );
  assert.deepEqual(
    validatePaidInvoice({
      id: "in_trial",
      status: "paid",
      amount_paid: 0,
      currency: "usd",
    }),
    { data: null },
  );
});

test("rejects malformed paid invoice data", () => {
  assert.match(
    validatePaidInvoice({
      id: "in_bad",
      status: "paid",
      amount_paid: 1.5,
      currency: "usd",
    }).error,
    /invalid paid invoice/,
  );
});

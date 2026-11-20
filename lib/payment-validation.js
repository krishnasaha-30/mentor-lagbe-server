export function validatePaidInvoice(invoice) {
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) {
    return { error: "Stripe returned an invalid invoice." };
  }

  if (invoice.status !== "paid" || invoice.amount_paid === 0) {
    return { data: null };
  }

  if (
    typeof invoice.id !== "string" ||
    !Number.isSafeInteger(invoice.amount_paid) ||
    invoice.amount_paid < 0 ||
    typeof invoice.currency !== "string" ||
    !/^[a-z]{3}$/i.test(invoice.currency)
  ) {
    return { error: "Stripe returned an invalid paid invoice." };
  }

  return {
    data: {
      invoiceId: invoice.id,
      amountMinor: invoice.amount_paid,
      currency: invoice.currency.toLowerCase(),
    },
  };
}

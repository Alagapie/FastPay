// FastPay's own classification of what the customer is complaining about.
// FastPay receipts don't say what went wrong, so the type comes from the customer's words,
// and the investigation later decides whether the records support it.
export const COMPLAINT_TYPES = {
  RECIPIENT_NOT_CREDITED: {
    label: 'Recipient did not receive the money',
    meaning: 'The customer sent money to someone, and that person says they did not receive it.',
  },
  TOP_UP_NOT_REFLECTED: {
    label: 'Added money is not in the balance',
    meaning: 'The customer added money (top-up or deposit, e.g. with PayPal or a card), and it is not in their FastPay balance.',
  },
  CASH_OUT_NOT_RECEIVED: {
    label: 'Cash out did not arrive',
    meaning: 'The customer cashed out or withdrew money to PayPal, and it did not arrive.',
  },
  EXPECTED_MONEY_NOT_RECEIVED: {
    label: 'Money sent to me has not arrived',
    meaning: 'Someone says they sent or paid the customer (or paid the customer\'s request), and the customer did not get it.',
  },
  DUPLICATE_PAYMENT: {
    label: 'Charged more than once',
    meaning: 'The customer was charged, or a payment went out, more than once.',
  },
  WRONG_AMOUNT: {
    label: 'Wrong amount',
    meaning: 'The amount taken or received is different from what the customer expected.',
  },
  REFUND_NOT_RECEIVED: {
    label: 'Money not returned',
    meaning: 'A failed, cancelled or reversed payment should have been returned to the customer, but was not.',
  },
  UNRECOGNIZED_TRANSACTION: {
    label: 'Transaction not recognised',
    meaning: 'The customer does not recognise a transaction, or says they did not make or authorise it.',
  },
  OTHER: {
    label: 'Other payment problem',
    meaning: 'Any other problem with a payment.',
  },
};

export const isComplaintType = (t) => Object.hasOwn(COMPLAINT_TYPES, t);
export const complaintLabel = (t) => COMPLAINT_TYPES[t]?.label ?? COMPLAINT_TYPES.OTHER.label;

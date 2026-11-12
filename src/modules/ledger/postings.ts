import { DbClient } from "../../db/connection.js";
import { postJournal } from "../wallet/wallet-ledger.js";

/** Post one balanced debit/credit pair as a single journal transaction tied to an economic event. */
export async function postTwoLineJournal(
  tx: DbClient,
  p: {
    tenantId: string;
    eventId: string;
    reference: string;
    currency: string;
    amount: string;
    debitCode: string;
    creditCode: string;
  },
): Promise<void> {
  await postJournal(tx, {
    tenantId: p.tenantId,
    eventId: p.eventId,
    reference: p.reference,
    currency: p.currency,
    lines: [
      { accountCode: p.debitCode, side: "debit", amount: p.amount },
      { accountCode: p.creditCode, side: "credit", amount: p.amount },
    ],
  });
}

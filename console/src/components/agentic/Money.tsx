import React from "react";

/** The server's decimal string followed by the ISO code. No arithmetic, no rounding, no parsing. */
export const Money: React.FC<{ amount: string; currency: string }> = ({ amount, currency }) => (
  <span className="money">{amount} {currency}</span>
);

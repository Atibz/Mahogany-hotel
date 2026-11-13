# Room-linked Restaurant and Bar orders

Restaurant and Bar remain separate businesses with separate orders, receipts, and payment ledgers. A hotel room is not a payment method.

When a checked-in guest orders from either outlet, staff select **This order is for a checked-in room guest**, enter the room number, verify the current occupant, and confirm the match before opening the order. Walk-in customers who are not staying at the hotel use the ordinary unlinked order path.

The Departures screen shows unpaid or pending-verification orders linked to a stay. Checkout is blocked until the outlet collects and confirms its own payment, or an approved combined-payment exception has been completed and verified. The database checks this again when the stay changes to checked out, so a stale screen or alternative checkout action cannot bypass it. An unpaid outlet sale is never added to the hotel's folio or hotel revenue by this link.

Orders created before this feature have no stay link. Reception must continue confirming other incidentals with the guest and outlet teams; those historical orders cannot be assumed settled merely because the Departures screen shows no linked hold. A room transfer does not remove the stay link from an existing order.

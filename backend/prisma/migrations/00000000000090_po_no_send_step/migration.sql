-- A purchase order no longer has a "sent to vendor" stop: an approved PO is an
-- order, and goods can be received (GRN) straight away. Rows stamped before the
-- step was removed sit at APPROVED so they open in the receiving state, not in
-- a status no screen offers a way out of.
UPDATE "purchase_orders"
SET "status" = 'APPROVED',
    "updatedAt" = now()
WHERE "status" = 'SENT_TO_VENDOR';

-- Special Request: free-text special instruction on car requests
-- (e.g. "wait and call me when ready", "carrying goods — plan a load-capable
-- car"). Shown to Administration on the request panel/assignment queue and to
-- the driver on the Telegram trip card.
ALTER TABLE "car_requests" ADD COLUMN "specialRequest" TEXT;

#!/usr/bin/env bash
# =============================================================
# AMS — Reset the TESTING stack to a clean seed state (192.168.100.110).
# TESTING = project "ams-test" → UI http://192.168.100.110:8030 (PRODUCTION = :80).
#
# What "clean" means here:
#   1. wipes every request-family table (cars, meeting rooms, office supply,
#      generic docs, attachments, stock ledger, supplier drafts, delegations,
#      approval actions, notifications, audit trails) and resets vehicles/drivers
#      to AVAILABLE — same FK-safe order reset-testing-env.sh uses
#   2. deletes ALL temporary/test users ever created for verification
#      (@ams-test.local) and frees their Telegram chat bindings + employee links
#   3. re-runs the seed (backend/prisma/seed.js) so roles, workflows, demo org
#      data, inventory, fleet and rooms are all present again
#   4. resets EVERY user's password to the stack's SEED_PASSWORD — this is the
#      "reset temp credentials" step: any password changed while testing (incl.
#      sysadmin's) goes back to the seeded default
#   5. clears Telegram bindings and join requests so the bot starts unlinked
#
# The DESTRUCTIVE database part is env-gated: run with RESET_TESTING_I_UNDERSTAND=yes
# (kept non-interactive so CI/ssh one-liners never hang on a prompt).
#
# Usage:
#   RESET_TESTING_I_UNDERSTAND=yes bash scripts/server/reset-testing.sh
#   RESET_TESTING_I_UNDERSTAND=yes SKIP_RESTART=1 bash scripts/server/reset-testing.sh  # containers keep running
# =============================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"
BASE="http://127.0.0.1:3011/api" # testing backend loopback (UI :8030)
COMPOSE="docker compose -f compose.yaml -f compose.test.yaml --env-file .env.test"

[ "${RESET_TESTING_I_UNDERSTAND:-no}" = "yes" ] || {
  echo "REFUSING to run: this wipes the TESTING database (requests, audit, users' passwords)."
  echo "Re-run with: RESET_TESTING_I_UNDERSTAND=yes bash scripts/server/reset-testing.sh"
  exit 1
}
test -f .env.test || { echo "ERROR: .env.test missing in $DIR"; exit 1; }
# .env.test sets POSTGRES_USER/POSTGRES_DB/SEED_PASSWORD for the testing stack
set -a; . ./.env.test; set +a
PGUSER="${POSTGRES_USER:-ams}"
PGDB="${POSTGRES_DB:-ams}"
SEED_PW="${SEED_PASSWORD:-ChangeMe#2026}"

q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c "psql -U $PGUSER -d $PGDB -tA -v ON_ERROR_STOP=1"; }

if [ "${SKIP_RESTART:-0}" != "1" ]; then
  echo "== 1. Restart the testing stack (also clears in-memory login lockouts) =="
  $COMPOSE restart
  sleep 6
else
  echo "== 1. SKIP_RESTART=1 — leaving containers up (lockouts NOT cleared) =="
fi

echo "== 2. Wipe request-family tables (FK-safe order) =="
q "DELETE FROM car_expenses"
q "DELETE FROM car_trips"
q "DELETE FROM car_assignments"
q "DELETE FROM meeting_room_requests"
q "DELETE FROM car_requests"
q "DELETE FROM supplier_purchase_draft_lines"
q "DELETE FROM supplier_purchase_drafts"
q "DELETE FROM stock_transactions"
q "DELETE FROM office_supply_requests"
q "DELETE FROM approval_delegations"
q "DELETE FROM approval_actions"
q "DELETE FROM notifications"
q "DELETE FROM attachments"
q "DELETE FROM request_documents"
echo "   vehicles/drivers back to AVAILABLE"
q "UPDATE vehicles SET status='AVAILABLE' WHERE status<>'AVAILABLE'"
q "UPDATE drivers SET status='AVAILABLE' WHERE status<>'AVAILABLE'"

echo "== 3. Delete temp users + free their links =="
q "UPDATE telegram_join_requests SET \"boundUserId\"=NULL, \"boundDriverId\"=NULL WHERE \"boundUserId\" IN (SELECT id FROM users WHERE email LIKE '%@ams-test.local')"
q "UPDATE employees SET \"userId\"=NULL WHERE \"userId\" IN (SELECT id FROM users WHERE email LIKE '%@ams-test.local')"
q "DELETE FROM user_roles WHERE \"userId\" IN (SELECT id FROM users WHERE email LIKE '%@ams-test.local')"
q "DELETE FROM users WHERE email LIKE '%@ams-test.local'"
echo "   temp users left: $(q "SELECT count(*) FROM users WHERE email LIKE '%@ams-test.local'")"

echo "== 4. Reset every remaining user's password to SEED_PASSWORD =="
HASH=$(docker exec ams-test-backend-1 node -e "console.log(require('bcryptjs').hashSync(process.argv[1],10))" "$SEED_PW")
q "UPDATE users SET \"passwordHash\"='$HASH'"
echo "   users touched: $(q "SELECT count(*) FROM users") — all can log in with the seeded password"

echo "== 5. Clear Telegram bindings + join requests (bot starts unlinked) =="
q "UPDATE users SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL, \"telegramBindCode\"=NULL"
q "UPDATE drivers SET \"telegramChatId\"=NULL, \"telegramUsername\"=NULL, \"telegramBindCode\"=NULL"
q "DELETE FROM telegram_join_requests"

echo "== 6. Re-seed (roles, workflows, org, inventory, fleet, rooms) =="
# delete the demo flag so the demo block re-runs and resurrects anything deleted while testing
q "DELETE FROM system_settings WHERE key='seed.demo_data_v1'"
$COMPOSE exec -T backend sh -c "node prisma/seed.js"

echo "== 7. Verify =="
curl -fsS "$BASE/api/health" && echo
echo "users:         $(q "SELECT count(*) FROM users")"
echo "roles:         $(q "SELECT count(*) FROM roles")"
echo "workflows:     $(q "SELECT count(*) FROM approval_workflows")"
echo "vehicles:      $(q "SELECT count(*) FROM vehicles") (AVAILABLE: $(q "SELECT count(*) FROM vehicles WHERE status='AVAILABLE'"))"
echo "rooms:         $(q "SELECT count(*) FROM meeting_rooms")"
echo "inventory:     $(q "SELECT count(*) FROM inventory_items")"
echo "car docs:      $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='CAR_REQUEST'") (expect 0)"
LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"sysadmin\",\"password\":\"$SEED_PW\"}" "$BASE/auth/login")
echo "sysadmin login with seeded password: HTTP $LOGIN_CODE (expect 200/201)"
[ "$LOGIN_CODE" = "200" ] || [ "$LOGIN_CODE" = "201" ] || { echo "FAILED: seeded login broken"; exit 1; }

echo
echo "DONE — TESTING UI: http://192.168.100.110:8030 (all logins: $SEED_PW)"

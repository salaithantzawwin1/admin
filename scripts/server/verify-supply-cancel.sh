#!/usr/bin/env bash
# supply admin-cancel leg: approved supply request → admin cancel → requester notified
set -u
BASE=http://127.0.0.1:3000/api
q() { printf '%s\n' "$1" | docker exec -i ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tA' | tr -d '\r\n'; }
TOKEN_OF() { docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" "$1" "$2"; }
UID_=$(q "SELECT id FROM users WHERE username='salaithantzawwin'")
TTOKEN=$(TOKEN_OF "$UID_" salaithantzawwin)
SAID=$(q "SELECT u.id FROM users u JOIN user_roles ur ON ur.\"userId\"=u.id JOIN roles r ON r.id=ur.\"roleId\" WHERE r.name='SYSTEM_ADMIN' LIMIT 1")
STOKEN=$(TOKEN_OF "$SAID" sysadmin)
ITEM=$(q "SELECT id FROM inventory_items WHERE balance > 5 ORDER BY \"createdAt\" LIMIT 1")
echo "item: $ITEM"
SUP=$(curl -s -X POST -H "Authorization: Bearer $TTOKEN" -H 'Content-Type: application/json' \
  -d "{\"items\":[{\"itemId\":\"$ITEM\",\"quantity\":2}],\"note\":\"cancel E2E\"}" "$BASE/inventory/requests")
SREQ=$(printf '%s' "$SUP" | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.requestId||j.id)})")
echo "supply doc: $(q "SELECT \"docNumber\" FROM request_documents WHERE id='$SREQ'")"
curl -s -X POST -H "Authorization: Bearer $TTOKEN" "$BASE/requests/$SREQ/submit" >/dev/null
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/requests/$SREQ/approve" >/dev/null
echo "after approve: doc=$(q "SELECT status FROM request_documents WHERE id='$SREQ'") supply=$(q "SELECT status FROM office_supply_requests WHERE \"requestId\"='$SREQ'") balance=$(q "SELECT balance FROM inventory_items WHERE id='$ITEM'")"
echo "— admin cancel (INVENTORY_MANAGE):"
curl -s -X POST -H "Authorization: Bearer $STOKEN" -H 'Content-Type: application/json' -d '{"reason":"No longer needed"}' "$BASE/inventory/requests/$SREQ/admin-cancel" | head -c 80; echo
echo "doc: $(q "SELECT status FROM request_documents WHERE id='$SREQ'") (expect CANCELLED) · supply: $(q "SELECT status FROM office_supply_requests WHERE \"requestId\"='$SREQ'") (expect REJECTED)"
echo "requester CANCELLED notification: $(q "SELECT count(*) FROM notifications WHERE \"requestId\"::text='$SREQ' AND type='CANCELLED'") (expect 1)"
echo "— cleanup:"
q "DELETE FROM office_supply_requests WHERE \"requestId\"::text='$SREQ'" >/dev/null
q "DELETE FROM approval_actions WHERE \"requestId\"::text='$SREQ'" >/dev/null
q "DELETE FROM notifications WHERE \"requestId\"::text='$SREQ'" >/dev/null
q "DELETE FROM request_documents WHERE id::text='$SREQ'" >/dev/null
echo "supply docs remaining: $(q "SELECT count(*) FROM request_documents WHERE \"docType\"='OFFICE_SUPPLY_REQUEST'")"
echo done

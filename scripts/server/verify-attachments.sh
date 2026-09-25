#!/usr/bin/env bash
set -e
AID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''employee1'\''"' | tr -d '\r\n ')
ETOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:'$AID',username:'employee1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'5m'}))")
ADID=$(docker exec ams-test-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT id FROM users WHERE username = '\''admin1'\''"' | tr -d '\r\n ')
ATOKEN=$(docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:'$ADID',username:'admin1'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'5m'}))")
# admin1 creates a throwaway generic request (stays DRAFT — cleanup after)
RID=$(curl -s -X POST http://127.0.0.1:3000/api/requests -H "Authorization: Bearer $ATOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"ACL-verify temp request","docType":"GENERIC_REQUEST"}' | docker exec -i ams-test-backend-1 node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
echo "admin1 temp request = $RID"
echo "--- employee1 lists admin1's request attachments (expect 403):"
curl -s "http://127.0.0.1:3000/api/attachments/request/$RID" -H "Authorization: Bearer $ETOKEN"
echo
echo "--- admin1 lists own request attachments (expect 200 []):"
curl -s "http://127.0.0.1:3000/api/attachments/request/$RID" -H "Authorization: Bearer $ATOKEN"
echo
echo "--- cleanup temp request:"
docker exec ams-test-db-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"DELETE FROM request_documents WHERE id = '$RID'\"" && echo deleted

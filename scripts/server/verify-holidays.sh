#!/usr/bin/env bash
# Verify the holidays endpoints on the Testing stack.
set -e
docker exec ams-backend-1 node -e "
const jwt=require('jsonwebtoken');
const {PrismaService}=require('/app/dist/prisma/prisma.module');
(async()=>{
  const p=new PrismaService();
  await p.\$connect();
  const u=await p.user.findFirst({where:{username:'sysadmin'}});
  process.stdout.write(jwt.sign({sub:u.id,username:'sysadmin'}, process.env.JWT_SECRET||'dev_only_secret_change_me',{expiresIn:'5m'}));
  await p.\$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)})
" > /tmp/tok.txt
TOK=$(cat /tmp/tok.txt)
echo "TOK_LEN=${#TOK}"
echo "--- GET /settings/holidays/2026 (defaults):"
curl -s http://127.0.0.1:3000/api/settings/holidays/2026 -H "Authorization: Bearer $TOK" | head -c 300
echo
echo "--- PUT /settings/holidays/2026 (superuser, expect permission denied? SYSTEM_ADMIN is superuser so should work):"
curl -s -X PUT http://127.0.0.1:3000/api/settings/holidays/2026 -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"holidays":[{"date":"2026-12-25","name":"Christmas Day"}]}' | head -c 200
echo
echo "--- GET after PUT:"
curl -s http://127.0.0.1:3000/api/settings/holidays/2026 -H "Authorization: Bearer $TOK"
echo
echo "--- restore defaults (empty PUT keeps defaults? no — PUT replaces with []):"
curl -s -X PUT http://127.0.0.1:3000/api/settings/holidays/2026 -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"holidays":[{"date":"2026-01-01","name":"New Year'\''s Day"},{"date":"2026-01-04","name":"Independence Day"},{"date":"2026-02-12","name":"Union Day"},{"date":"2026-03-02","name":"Peasants'\'' Day"},{"date":"2026-03-27","name":"Armed Forces Day"},{"date":"2026-04-13","name":"Thingyan (Water Festival)"},{"date":"2026-04-14","name":"Thingyan (Water Festival)"},{"date":"2026-04-15","name":"Myanmar New Year Day"},{"date":"2026-04-16","name":"Thingyan holiday"},{"date":"2026-04-17","name":"Thingyan holiday"},{"date":"2026-05-01","name":"Labour Day"},{"date":"2026-07-19","name":"Martyrs'\'' Day"},{"date":"2026-12-25","name":"Christmas Day"}]}' | head -c 120
echo

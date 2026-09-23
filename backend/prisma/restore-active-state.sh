#!/bin/bash
docker exec -i ams-db-1 sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB' <<'SQL'
\echo === restore real state: CAR-2026-0001 trip is live today on YGN-1234 / U Aung Kyaw ===
UPDATE vehicles SET status='IN_USE' WHERE "vehicleNo"='YGN-1234'
  AND EXISTS (SELECT 1 FROM car_requests cr JOIN request_documents rd ON rd.id=cr."requestId"
              WHERE cr."vehicleId"=vehicles.id AND rd."docNumber"='CAR-2026-0001');
UPDATE drivers SET status='ON_TRIP' WHERE name='U Aung Kyaw'
  AND EXISTS (SELECT 1 FROM car_requests cr JOIN request_documents rd ON rd.id=cr."requestId"
              WHERE cr."driverId"=drivers.id AND rd."docNumber"='CAR-2026-0001');
SELECT "vehicleNo", status FROM vehicles ORDER BY "vehicleNo";
SELECT name, status FROM drivers ORDER BY name;
SELECT rd."docNumber", rd.status, cr.status AS car_status, v."vehicleNo"
FROM request_documents rd
JOIN car_requests cr ON cr."requestId"=rd.id
LEFT JOIN vehicles v ON v.id=cr."vehicleId"
WHERE rd."docType"='CAR_REQUEST' ORDER BY rd."docNumber";
SQL

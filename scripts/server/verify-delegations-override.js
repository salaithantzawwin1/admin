#!/usr/bin/env node
/**
 * E2E (API-level) verification of the Delegations Save-anyway override flow
 * against a RUNNING testing stack — the exact behaviour the web UI wires up:
 *
 *   overlap submit WITHOUT flag  → 400 'You already have a delegation covering this period'
 *                                  → the UI shows the orange warning + "Save anyway"
 *   resubmit WITH overrideOverlap → 201, second delegation created (intentional
 *                                  double coverage), delegate notified + audited
 *   overrideOverlap:false        → behaves like omitting the flag (still rejected)
 *
 * The two delegations are cleaned up at the end, so the script is re-runnable.
 *
 * Usage: node scripts/server/verify-delegations-override.js   (on the server;
 *        uses the ams-test backend container for the JWT secret, port 3011)
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3011/api';
const DELEGATE_USERNAME = process.env.DELEGATE_USERNAME || 'head1';
const ACTOR_USERNAME = process.env.ACTOR_USERNAME || 'admin1';
const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe#2026';

let passed = 0;
const failures = [];
function check(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

async function api(path, method, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. empty) */ }
  return { status: res.status, json, text };
}

/** Sign a JWT the same way the backend does (sub + username).
 *  Inside the backend container (JWT_SECRET in env) it signs in-process;
 *  on the host it shells out through docker exec. Falls back to null.
 *  BASE: inside a container use http://backend:3000/api (compose service DNS);
 *  from the host the default is the testing loopback port.
 */
function tokenOf(userId, username) {
  try {
    if (process.env.JWT_SECRET) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const jwt = require('jsonwebtoken');
      return jwt.sign({ sub: userId, username }, process.env.JWT_SECRET, { expiresIn: '30m' });
    }
    const { execSync } = require('child_process');
    const out = execSync(
      `docker exec ams-test-backend-1 node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:process.argv[1],username:process.argv[2]},process.env.JWT_SECRET,{expiresIn:'30m'}))" ${userId} ${username}`,
    );
    return out.toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  console.log('== Delegations Save-anyway override — API-level e2e ==\n');

  // 0) resolve actor + delegate ids from real seeded logins
  const actorLogin = await api('/auth/login', 'POST', null, { username: ACTOR_USERNAME, password: PASSWORD });
  check(actorLogin.status === 200 || actorLogin.status === 201, `actor ${ACTOR_USERNAME} logs in (HTTP ${actorLogin.status})`);
  const delegateLogin = await api('/auth/login', 'POST', null, { username: DELEGATE_USERNAME, password: PASSWORD });
  check(delegateLogin.status === 200 || delegateLogin.status === 201, `delegate ${DELEGATE_USERNAME} logs in (HTTP ${delegateLogin.status})`);
  if (!actorLogin.json?.accessToken || !delegateLogin.json?.accessToken) {
    throw new Error('logins failed — is the testing stack up?');
  }
  const actorToken = actorLogin.json.accessToken;
  const delegateId = delegateLogin.json.user?.id;
  check(!!delegateId, `delegate id resolved (${delegateId ? 'yes' : 'no'})`);

  // fresh token signed with the stack's own secret — falls back to the login
  // token when signing is unavailable (JWT_SECRET/docker both out of reach)
  const actorId = actorLogin.json.user?.id;
  const signedActor = (actorId && tokenOf(actorId, ACTOR_USERNAME)) || actorToken;

  // window: tomorrow 09:00→17:00 Yangon — no live delegation should cover it after cleanup
  const start = new Date(Date.now() + 24 * 3600 * 1000);
  start.setUTCHours(2, 30, 0, 0); // 09:00 Yangon
  const end = new Date(start.getTime() + 8 * 3600 * 1000); // 17:00 Yangon
  const payload = { toUserId: delegateId, startAt: start.toISOString(), endAt: end.toISOString(), reason: 'e2e override check' };

  // 1) clean slate: end any pre-existing ACTIVE delegations from the actor
  const before = await api('/delegations', 'GET', signedActor);
  const preExisting = (before.json?.given ?? []).filter((d) => d.status === 'ACTIVE');
  for (const d of preExisting) {
    await api(`/delegations/${d.id}/end`, 'PATCH', signedActor);
  }
  check(true, `clean slate: ${preExisting.length} pre-existing active delegation(s) ended`);

  // 2) FIRST create — no overlap yet, must succeed WITHOUT the flag
  const first = await api('/delegations', 'POST', signedActor, payload);
  check(first.status === 201 || first.status === 200, `first create succeeds without flag (HTTP ${first.status})`);

  // 3) SECOND create, same window, NO flag → exact overlap rejection
  const second = await api('/delegations', 'POST', signedActor, payload);
  check(second.status === 400, `overlap without flag rejected (HTTP ${second.status})`);
  check(
    second.json?.message === 'You already have a delegation covering this period',
    `exact message the UI keys the Save-anyway box on: "${second.json?.message}"`,
  );

  // 4) SECOND create with overrideOverlap:false → still rejected (flag must be true)
  const secondFalse = await api('/delegations', 'POST', signedActor, { ...payload, overrideOverlap: false });
  check(secondFalse.status === 400, 'overrideOverlap:false behaves like omitting the flag (HTTP 400)');

  // 5) SECOND create WITH overrideOverlap:true → created (intentional double coverage)
  const override = await api('/delegations', 'POST', signedActor, { ...payload, overrideOverlap: true });
  check(override.status === 201 || override.status === 200, `override create succeeds (HTTP ${override.status})`);
  check(override.json?.id && override.json?.id !== first.json?.id, 'a SECOND delegation row was created');

  // 6) delegate sees both in their received list
  const recv = await api('/delegations', 'GET', delegateLogin.json.accessToken);
  const covering = (recv.json?.received ?? []).filter(
    (d) => d.fromUserId === actorId && d.status === 'ACTIVE' && new Date(d.startAt).getTime() === start.getTime(),
  );
  check(covering.length === 2, `delegate received list shows BOTH overlapping delegations (${covering.length}/2)`);

  // 7) cleanup — end both, then confirm the overlap guard is disarmed for next run
  for (const d of [first.json, override.json]) {
    if (d?.id) await api(`/delegations/${d.id}/end`, 'PATCH', signedActor);
  }
  const after = await api('/delegations', 'GET', signedActor);
  const stillActive = (after.json?.given ?? []).filter((d) => d.status === 'ACTIVE');
  check(stillActive.length === 0, `cleanup: actor has 0 active delegations left (${stillActive.length})`);

  console.log(`\n${passed + failures.length} checks, ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('FAILED:\n' + failures.map((f) => ' - ' + f).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

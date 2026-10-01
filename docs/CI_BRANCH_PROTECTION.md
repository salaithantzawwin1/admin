# CI gate + branch protection for `main`

Since commit f626a85 the repository runs GitHub Actions CI (`.github/workflows/ci.yml`)
on every push and PR targeting `main`:

- **Backend — typecheck + suites**: `npm ci`, `npx tsc --noEmit`, `npm test`
  (cars-fixes, fleet-vehicle-creation, delegations-override, rbac-deny-memory,
  telegram-car-request).
- **Frontend — typecheck + build**: `npm ci`, `npx tsc --noEmit`, `npm run build`.
- **CI gate**: aggregate job that is green only when both jobs succeeded —
  require THIS single check in branch protection, not the two jobs themselves
  (a required job that gets *skipped* would otherwise count as "passing").

## One-time setup (GitHub UI)

1. Open https://github.com/salaithantzawwin1/admin/settings/branches
   (requires **admin** on the repository).
2. **Add branch ruleset** (or classic *Add rule* → *Branch protection rule"):
   - Branch name pattern: `main`
   - ✅ **Require a pull request before merging**
   - ✅ **Require status checks to pass before merging**
     - Search and add the check: **CI gate**
     - ✅ *Require branches to be up to date before merging*
   - Recommended extras:
     - ✅ *Require conversation resolution before merging*
     - ✅ *Do not allow bypassing the above settings* (admins included —
       otherwise every admin merge silently skips the gate)
3. Save. From then on, a red or missing CI gate blocks the **Merge pull
   request** button on every PR into `main`.

## One-time setup (GitHub CLI alternative)

```bash
# requires a token with repo admin scope
gh api repos/salaithantzawwin1/admin/rulesets -f name=protect-main \
  -f target=branch -F enforcement=active \
  -f 'conditions[ref_name][include][]=refs/heads/main' \
  -f 'conditions[ref_name][exclude][]' \
  -f 'rules[][type]=pull_request' \
  -f 'rules[][type]=required_status_checks' \
  -f 'rules[][parameters][required_status_checks][context]=CI gate' \
  -f 'rules[][parameters][required_status_checks][strict_integration]=true' \
  -q '.'
```

(Or the classic endpoint: `PUT /repos/…/branches/main/protection` with
`required_status_checks.contexts=["CI gate"]`.)

## Notes / gotchas

- The gate job runs `if: ${{ !cancelled() }}` so a failed backend/frontend job
  turns the gate red instead of leaving it "pending" forever.
- The first CI run already earned its keep: it caught the `toLocaleString`
  timezone bug (UTC runner vs Asia/Yangon container) that production masked —
  fixed in c03da1b, and all Telegram date formatting is now consolidated on the
  TZ-safe helpers in `backend/src/util/yangon-time.ts`.
- Force pushes and deletions of `main` are denied by the same ruleset once
  created.

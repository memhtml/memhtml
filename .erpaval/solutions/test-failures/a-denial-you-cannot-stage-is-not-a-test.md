# A denial you cannot stage is not a test: chmod-bit guards must cover every environment that ignores them

**Tags**: windows, chmod, posix-bits, test-guards, skip-with-reason, root **Modules**: packages/traces/tests, apps/cli/tests

## The failure

Four traces tests and one CLI trace-index test stage a read failure with `chmod(path, 0o000)`, assert the failed-read accounting, and passed on Linux CI forever. On Windows the POSIX mode bits are STORED but not ENFORCED for the file's owner, so `0o000` does not deny anything: the read SUCCEEDS, the denial branch never runs, and the test red-screens asserting that a successful read is a failed one. uid 0 is the same class — root opens a mode-000 file — and the repo already had a guard for exactly that (`ctx.skip(RUNNING_AS_ROOT, CHMOD_INEFFECTIVE)` in `packages/traces/tests/scan.test.ts:38`), with the reason on the record.

## The rule

**A guard that skips "the environment ignores what I stage" must enumerate EVERY such environment, not the first one discovered.** The root guard existed; win32 produces the identical failure shape and was not covered, so a whole platform's runs were red noise. The fix extends the constant once — `CHMOD_CANNOT_DENY = getuid() === 0 || platform === "win32"` — with the skip REASON stating the mechanism per platform ("win32 stores but does not enforce the POSIX mode bits for the owner"), because a green run that measured nothing is worse than a visibly absent one.

Two discipline points the incident reinforced:

1. **Fix the guard, not the assertion.** Weakening the assertion to pass on win32 would hide a real regression on Linux. The skip carries its reason; Linux CI still runs the full denial path.
2. **Red-under-an-OS is a signal to stash-baseline, not to revert.** These tests looked identical to regressions from the audit branch; the baseline run (changes stashed) reproduced them byte-for-byte, which is what let the real fixes land alongside honest skips.

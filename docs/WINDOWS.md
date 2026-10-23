# Windows development notes

Upstream CI runs on `ubuntu-latest` only, so Windows behaviour is untested there.
These notes record what actually happens on Windows and what is still broken.

## Install

`npm ci` fails on a machine without Visual Studio Build Tools: `better-sqlite3`
falls back to a `node-gyp` source build. The published tarball already ships
N-API prebuilds (`node_modules/better-sqlite3/prebuilds/win32-x64.node`), so the
install script is not needed:

```bash
npm ci --ignore-scripts
node -e "new (require('better-sqlite3'))(':memory:')"   # sanity check
```

## Run the tests

```bash
npm run check   # tsc --noEmit
npm test        # one process per test file, TEST_TIMEOUT=120s default
```

`npm test` now uses `scripts/run-tests.mjs`. The previous `tests/run-all.sh` could
not run from an npm script on Windows at all — `npm` shells out to `cmd.exe`,
which reports `'tests' is not recognized`.

## Baseline (0.9.11, Node 22.21, Windows 11)

`54 of 59 test files pass`. The five failures below are known and reproducible;
none of them is caused by the fork's changes.

| Test file | Failure | Cause | Next step |
|---|---|---|---|
| `tests/project-rebinding.test.ts` | hangs until the 120s runner timeout | Test waits on a spawned child Pi process that does not exit on Windows | Investigate child spawn/kill semantics (upstream branch `fix/windows-pi-child-spawn` is related) |
| `tests/handlers/pi-child-process.test.ts` | assertion failures (process-tree watchdog, argv/temp-file handling) | Windows process-tree and argv differences | Needs a Windows-specific expectation or a product fix |
| `tests/handlers/skills-command.test.ts` | assertion failure in `collectLoadedSkillsFromCommands` | Path parsing differs on Windows | Compare `path.win32` vs `path.posix` handling |
| `tests/store/sqlite-lazy-load.test.ts` | assertion failure | Native loader expectations do not match the prebuilt-binary install | Reproduce with a source build before changing expectations |
| `tests/store/sqlite-native.test.ts` | assertion failure (ABI-mismatch rebuild path) | Rebuild path is untested on Windows and needs `node-gyp` | Decide whether to keep the rebuild path on Windows |

## Known limitation: migrating while another process holds the database

The migration moves `sessions.db` and its `-wal`/`-shm` sidecars. Windows cannot
rename a file that another process has open, so migrating while a second Pi
instance (or the test's own connection) holds the legacy database fails with
`EBUSY` and is reported as a critical failure. Three subtests in
`tests/extension-root-migration.test.ts` keep such a connection open and are
skipped on Windows for that reason. A retry-or-defer path for a busy database is
still missing.

## Already fixed here

- Test teardown released no lock handles, so `fs.rm` on a store directory failed
  with `EBUSY` on `.pi-hermes-locks.sqlite`. `AtomicLockCoordinator.closeHandles()`
  plus `tests/helpers/cleanup.ts` fixed ten test files.
- The root migration held its `BEGIN IMMEDIATE` write lock while renaming the
  SQLite generation, which made `sync-markdown-memories` fail on Windows. The
  lock is now released (and the file list re-read) before the move.
- The suite had no runnable entry point on Windows; `scripts/run-tests.mjs`
  replaced the shell runner.

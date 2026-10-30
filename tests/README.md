# Isolated verification sources

Tests, browser fixtures, native probes, and packaging fixtures belong here, not
in the production `src/` tree. Run them only when explicitly requested, with
isolated profiles and data roots where required.

## Layout

- `main/`, `preload/`, `renderer/`, `shared/`: mirror the corresponding source areas.
- `packaging/`: packaging assertions and `fixtures/release-metadata/`.
- `native/clipboard/`: native helper checks and their Cocoa/Python fixtures.
- `main/plugin/*.native-bench.mjs`: opt-in native benchmarks.
- `main/plugin/realAppPerformance.*.mjs`: opt-in real-application probe.
- `fixtures/browser-preview/`: browser-only mock API, sample catalog, shortcut
  fixtures, preview page composition, and generated plugin icons. These are not
  production catalog data. The development server exposes the isolated entry at
  `/preview/` (`/preview/?surface=quick` for the Quick fixture); ordinary `/`
  remains the production shell entry and no longer imports preview pages.

The production dependency graph must not include this directory. The sole source
exception is the lazy dynamic import in `src/renderer/services/shellApi.ts`, in
the true branch of `import.meta.env.DEV` when no native preload is present. Its
`@test/fixtures/browser-preview/mockShellApi` dependency is removed from release
builds. A missing production preload must never silently use fixture data.
The preview entry is served by a development-only Vite middleware, not included
in renderer build inputs. Its separate `tsconfig.json` supports static checking
without adding fixture UI to the production dependency graph.

Test-only observations of private timers, drag state and activity leases are
injected by the corresponding test build adapters, not exported by production
modules. DROPFILES fixture codecs also live here; production clipboard URI-list
codecs remain in `src/main/clipboard/clipboardFormats.ts`.

Three small host entry/path hooks intentionally remain: `ENEST_TEST_USER_DATA`
selects an isolated Electron profile, and `ENEST_TEST_DATA_ROOT` selects an
isolated data root and prevents migration of real user directories. These are
profile safety infrastructure, not test cases, mocks or plugin behavior. They
also protect explicitly requested packaged-app checks; do not remove them or
make them DEV-only without an equivalent isolation mechanism.

`npm run audit:source` inventories physical files, parses source imports and
reports these explicit exceptions without executing the application or tests.
After a build, `npm run audit:source -- --build-output` also inspects emitted
artifacts for fixture markers and sandbox-preload dependencies. It is a static
boundary check, not evidence that historical cases or native interactions pass.

## Running a selected check

Run commands from the repository root, and only when explicitly requested.
There is intentionally no command that indiscriminately runs every native or
browser fixture. Individual files document their opt-in environment variables.

```sh
node --test tests/shared/accelerator.test.mjs
npm run test:packaging
ENEST_APP_SMOKE=1 node --test tests/main/plugin/pluginApp.smoke.test.mjs
```

The first command is a selected unit test; the last one requires existing build
outputs and launches Electron with an isolated profile. Neither is part of
`npm run typecheck` or `npm run build`.

To locate a moved module, replace `src/` with `tests/`, or `tools/packaging/` with
`tests/packaging/`. Native helper checks live in `tests/native/clipboard/`.
Maintained filenames no longer include creation dates or edit-round numbers;
use the module responsibility to locate a renamed case. See the shared
[file naming rules](../AGENTS.md).
Local screenshots, JSON reports, and benchmark output belong under
`.cache/verification/<module>/`, not the public `docs/` tree. Explicit environment
or `--output` overrides remain available where supported. Relocating a fixture
or its output does not refresh any previous verification result.

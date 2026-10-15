# eNest release tooling

The shell build uses native macOS x64/arm64, Windows x64, and Ubuntu 22.04 x64 runners. Node 24 and the locked electron-builder toolchain are required. `npm run build` must finish before packaging so the bundled UI license notices exist.

- `collect-bundled-licenses.mjs` reads renderer runtime imports through the TypeScript parser, resolves their installed package roots and transitive dependencies, and preserves license/notice files in `out/licenses/bundled-ui`. When a package such as GSAP publishes its notice in README/package metadata, those records are preserved. Test/type-only imports are excluded.
- `after-pack.mjs` verifies the actual ASAR contains bundled UI notices and no migrated database/middleware/SSH drivers or source maps. It checks Chromium/FFmpeg resources, runtime icons, and retained locales. It does not delete Electron runtime files. On macOS it also places Electron/Chromium notices inside the final app bundle.
- electron-builder 26.15.3 performs locale pruning in both macOS resource directories. macOS locale IDs use `en`, `zh_CN`, `zh_TW`; Windows/Linux use `en-US`, `zh-CN`, `zh-TW`.
- `assemble-release.mjs <artifacts> <output>` accepts the four separate `enest-{platform}-{arch}` artifact directories. It validates required installers/blockmaps, metadata versions, SHA-512 digests and sizes, then merges both macOS architecture records into one `latest-mac.yml`. Existing output or filename collisions are errors. The legacy path/checksum fields remain paired with the x64 ZIP; current electron-updater selects the correct ZIP through `files`.
- The final workflow validates release assets on manual runs as well as tags. Only a `v*` tag publishes. It uploads combined update metadata separately without re-uploading every installer.

Run `npm run test:packaging` (or `node --test tools/packaging/*.test.mjs`). Metadata fixtures exercise the real electron-updater architecture filter plus corrupt, incomplete and conflicting release inputs. These tests do not replace native installer/startup/update tests on all supported platforms.

The three existing `build/icon.{icns,ico,png}` files are release inputs and are explicitly allowed by `.gitignore`; include them when committing this change. Runtime icon resources are limited to `dock-runtime.png` and `enest-icon-256.png`. The toolchain, Electron downloads and native headers are cached per OS/architecture/lockfile, without sharing `node_modules` across architectures.

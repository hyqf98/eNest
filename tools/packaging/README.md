# eNest release tooling

The shell build uses native macOS x64/arm64, Windows x64, and Ubuntu 22.04 x64 runners. Node 24 and the locked electron-builder toolchain are required. `npm run build` must finish before packaging so the bundled UI license notices exist.

- `collect-bundled-licenses.mjs` reads renderer runtime imports through the TypeScript parser and adds explicitly bundled main runtime packages (`undici`, only when declared in the project's `devDependencies`). It resolves their installed package roots and transitive dependencies and preserves license/notice files in `out/licenses/bundled-ui`; the manifest records separate `rendererRoots` and `mainRoots`. Ordinary main runtime dependencies ship with their package notices. When a package such as GSAP publishes its notice in README/package metadata, those records are preserved. Local aliases (including the DEV-only `@test` entry), test files and type-only imports are excluded.
- `after-pack.mjs` verifies the actual ASAR contains bundled UI notices and no migrated database/middleware/SSH drivers or source maps. It checks Chromium/FFmpeg resources, runtime icons, retained locales and the real executable/native binary headers. It does not delete Electron runtime files. On macOS it also places Electron/Chromium notices inside the final app bundle.
- The locked electron-builder version performs locale pruning in both macOS resource directories. macOS locale IDs use `en`, `zh_CN`, `zh_TW`; Windows/Linux use `en-US`, `zh-CN`, `zh-TW`.
- `native-release.mjs` inspects Mach-O/universal Mach-O, PE and ELF headers without executing foreign binaries. macOS includes only the two Mach-O helpers; Windows includes only the two PowerShell source helpers; Linux includes its ELF clipboard helper, non-glibc shared libraries, dependency inventory and notices. Mixed native/bin contents cannot leak through the per-platform extraResources filters. Missing/mismatched architecture, unexpected helpers, symlinks, corrupt Linux dependency hashes, or a Linux build newer than the glibc 2.35 baseline fail packaging instead of producing a mislabeled package.
- `release-manifest.mjs <release-directory> <darwin|win32|linux> <arch>` rechecks the final unpacked payload after packaging/signing and records artifact sizes/SHA-256 plus native formats, architectures and hashes in `release-manifest-<platform>-<arch>.json`. The hook's temporary locator stays outside the app, so recording final hashes does not modify a signed application. These checks are explicitly static; the report sets `runtimeValidated: false`.
- `assemble-release.mjs <artifacts> <output>` accepts the four separate `enest-{platform}-{arch}` artifact directories. Its release CLI requires all four manifests, verifies artifact SHA-256/size coverage plus update metadata SHA-512, versions and required installers/blockmaps, then merges both macOS architecture records into one `latest-mac.yml`. Existing output or filename collisions are errors. The legacy path/checksum fields remain paired with the x64 ZIP; current electron-updater selects the correct ZIP through `files`. The four platform manifests are preserved alongside the release assets.
- The final workflow validates release assets on manual runs as well as tags. Only a `v*` tag publishes. It uploads combined update metadata separately without re-uploading every installer.

When explicitly requested, run `npm run test:packaging` (or `node --test tests/packaging/*.test.mjs`). Metadata fixtures exercise the real electron-updater architecture filter plus corrupt, incomplete and conflicting release inputs. These tests do not replace native installer/startup/update checks on all supported platforms.

The three `build/icon.{icns,ico,png}` files are required release inputs and remain version-controlled. Runtime icon resources are limited to `dock-runtime.png` and `enest-icon-256.png`. The toolchain, Electron downloads and native headers are cached per OS/architecture/lockfile, without sharing `node_modules` across architectures.

## Local cross-platform package checks

After the final `npm run build`, macOS can produce a Windows x64 ZIP without Wine:

```sh
npx --no-install electron-builder --win zip --x64 --publish never \
  --config.win.signAndEditExecutable=false \
  --config.directories.output=release/windows-cross-check
node tools/packaging/release-manifest.mjs release/windows-cross-check win32 x64
```

This deliberately skips Windows executable resource editing and code signing. It is an unsigned cross-check ZIP, not proof of NSIS installation, the final Windows executable icon/metadata, PowerShell behavior, application startup or updates. Native Windows CI still builds NSIS plus ZIP with its normal resource-editing path. macOS x64/arm64 DMG and ZIP remain native CI targets.

Linux releases require a matching Linux x64/glibc builder and the compiler/dependency set in `.github/workflows/build.yml` (Ubuntu 22.04). A macOS clipboard helper is not a substitute for the required ELF helper and bundled libraries; the native check rejects it. Do not install tools, start Docker builds or label Linux runtime acceptance complete merely to satisfy a local artifact check. CI packaging is reproducible configuration, not evidence that the Linux desktop/X11/Wayland flows have been run.

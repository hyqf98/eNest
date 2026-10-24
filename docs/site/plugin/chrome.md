# Theme Chrome V1

eNest 0.2.1 adds optional theme-owned renderers for classic tabs, the floating rail and the settings dock. A renderer supplies HTML/CSS/JavaScript; the host owns native windows, content bounds, focus, modal/startup gates, process lifetime and permission checks.

Declare entries in a V2 theme pack:

```json
{
  "chrome": {
    "version": 1,
    "classic": { "entry": "chrome/tabs.html" },
    "rail": { "entry": "chrome/rail.html" },
    "dock": { "entry": "chrome/dock.html" }
  }
}
```

Each entry is optional. Missing or failed entries use the bundled default theme implementation. Entries must be installed, enabled, package-relative HTML assets; remote URLs, traversal, symlinks and private `backend`, `runtime`, `node_modules`, `src` and test directories are rejected. Package/build changes retire the old renderer. Switching classic/orb destroys the inactive native chrome rather than retaining both renderer processes.

## Renderer API

These documents receive only `window.enestChrome: ThemeChromeApi`, not `enest`, `enestShell`, `enestWindows`, Node.js or Electron. Use external JavaScript files; inline scripts, eval, remote scripts, frames and workers are blocked. A dedicated nonpersistent session denies permissions, downloads, popups and external HTTP requests. This is not a claim that Chromium's WebRTC IP policy is a complete network isolation boundary.

```js
const api = window.enestChrome;
const render = snapshot => {
  // Build your own controls using snapshot.tabs and snapshot.theme.tokens.
  // Treat plugin-provided titles as text, not HTML.
};
const unsubscribe = api.onSnapshot(render);
render(await api.getSnapshot());
await api.ready();
window.addEventListener('pagehide', unsubscribe, { once: true });
```

`ready()` acknowledges a usable first frame. The host keeps the default rail/dock during preparation and restores defaults on crash, load failure or a five-second readiness timeout. Classic tabs retain an inline fallback. Native traffic controls and a narrow move region cannot be covered by the custom classic surface.

Snapshots include surface (`classic`, `rail`, `dock`), view, tab style, active tab, tab title/glyph/color/badge/lazy/crashed flags, animation level, theme color tokens and registered rail contribution IDs. Custom renderers do **not** receive account/profile data, settings, credentials, command lines, filesystem paths or arbitrary plugin resource URLs. Optional `profile` and full `theme.appearance` in the TypeScript contract are internal compatibility fields for the trusted built-in adapter, not custom grants.

## Actions

```js
await api.dispatch({ type: 'activate', tabId });
await api.dispatch({ type: 'close', tabId });
await api.dispatch({ type: 'reorder', tabId, index: 0 });
await api.dispatch({ type: 'detach', tabId });
await api.dispatch({ type: 'home' });
await api.dispatch({ type: 'settings' });
await api.dispatch({ type: 'contribution', id: contributionId });
await api.dispatch({ type: 'expand', expanded: true });
```

All navigation/lifecycle actions require a recent native click or Enter/Space gesture on the visible, focused surface; synthetic DOM clicks do not grant authority. Tab IDs must belong to current shell tabs. Contribution IDs resolve through the host registry, never a caller-supplied plugin ID or feature code. `expand` is a bounded rail-only geometry hint; `dock` can only open settings. The host limits actions to 60 per second. Custom drag visuals can dispatch a validated reorder/detach action, but the private `enestWindows` drag bridge is not exposed.

The default visual code lives in `src/renderer/themes/default/chrome/`. Its classic implementation stays in the existing shell renderer to avoid creating a process merely to draw tabs; its rail/dock uses the same snapshot/action shape through a trusted adapter. The source-built default package declares these implementations. This does not install a second default theme plugin or grant third-party code trusted-shell access.

For plugin-owned settings pages and small-window/desktop content, use the existing private settings, `contributes.settings` page entry, launch-mode and UI contracts. Global security, installer, proxy, updates, account secrets and performance diagnostics remain host-owned; a theme never receives a writable copy of all settings.

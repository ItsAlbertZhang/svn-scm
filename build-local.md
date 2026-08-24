# Building this fork locally

Upstream has been unmaintained since 2022 and its toolchain (Node 12, webpack
5.48, TypeScript 4.3, node-sass 6, eslint 7) predates current Node by several
major versions. Two things break on a modern Node, and both have a fixed
workaround. This file records them so the build does not have to be
rediscovered.

Nothing here changes global state: the old Node is selected per-command via
`PATH`, never with `nvm use`.

## Prerequisites

- [nvm-windows](https://github.com/coreybutler/nvm-windows)
- Node **16.20.2** — the newest release `node-sass@6.0.1` ships a prebuilt
  binding for (ABI 93), and new enough that webpack 5.48 / ts-loader 9.2 /
  TypeScript 4.3 / eslint 7 / yarn 1.22 all run natively.

```
nvm install 16.20.2
```

`nvm install` only downloads into `%NVM_HOME%`; it does not switch the active
version. Confirm your global Node is untouched afterwards with `node -v`.

Every command below assumes this prefix, which scopes Node 16 to that command
only (adjust the path to your `%NVM_HOME%`):

```bash
export PATH="/c/Users/$USER/AppData/Local/nvm/v16.20.2:$PATH"
```

## Install dependencies

`yarn` is not required globally — run the pinned version through `npx`, and use
the committed lockfile:

```bash
npx yarn@1.22.22 install --frozen-lockfile
```

Verify the native binding landed, since this is the step most likely to fail:

```bash
ls node_modules/node-sass/vendor/     # expect win32-x64-93
node -e "require('node-sass')"        # must not throw
```

### If the node-sass binding fails

It is downloaded from GitHub releases, which can be slow or blocked. In order
of preference:

1. Retry with a mirror: `SASS_BINARY_SITE=https://npmmirror.com/mirrors/node-sass`
2. `npx yarn@1.22.22 install --frozen-lockfile --ignore-scripts`, then compile
   the one stylesheet with dart-sass instead:
   `npx sass scss/commit-message.scss css/commit-message.css --style=compressed`

Building from source is the last resort and needs Python plus MSVC Build Tools.

## Build

Call the local binaries directly. The `build:ts` / `build:css` npm scripts
invoke `yarn` recursively, which needs `yarn` on `PATH`; going straight to
`node_modules/.bin` avoids that.

```bash
./node_modules/.bin/webpack --mode production
./node_modules/.bin/node-sass scss/ -o css/ --output-style compressed
```

Products:

- `out/extension.js` — the bundle `package.json#main` points at
- `css/commit-message.css` — **required at runtime**, read by
  `src/messages.ts`. `.vscodeignore` excludes `scss/` but not `css/`, so this
  file has to exist before packaging.

## Package

`vsce` cannot simply be run with `npx`. `@vscode/vsce` depends on `cheerio`,
whose 1.0 release pulls in `undici@7`, which requires Node >= 20.18 and dies on
Node 16 with `ReferenceError: ReadableStream is not defined`. Running vsce on a
newer Node is not an option either: vsce executes the `vscode:prepublish`
script, which runs `node-sass`, whose binding is compiled for Node 16's ABI.

Resolve it by installing vsce in a throwaway directory with `cheerio` pinned to
the last release that has no `undici` dependency. `yarn` goes in the same
directory because both `vscode:prepublish` and vsce's own dependency
enumeration shell out to it.

```bash
mkdir -p /tmp/vsce-runner && cd /tmp/vsce-runner
cat > package.json <<'EOF'
{
  "name": "vsce-runner",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@vscode/vsce": "2.15.0",
    "yarn": "1.22.22"
  },
  "overrides": {
    "cheerio": "1.0.0-rc.12"
  }
}
EOF
npm install --no-audit --no-fund
```

The `overrides` field needs npm >= 8.3; Node 16.20.2 ships npm 8.19.4. Confirm
with `ls node_modules/undici` — it should not exist.

Then package from the repository root, with both binaries on `PATH`:

```bash
export PATH="/c/Users/$USER/AppData/Local/nvm/v16.20.2:/tmp/vsce-runner/node_modules/.bin:$PATH"
cd /e/code/svn-scm
vsce package -o svn-scm-$(node -p "require('./package.json').version").vsix
```

Do **not** pass `--no-dependencies`. `iconv-lite-umd` and `jschardet` are real
runtime `dependencies`, and upstream CI ships them in the marketplace build.
`src/vscodeModules.ts` prefers VSCode's own copies from `env.appRoot` and falls
back to these. Upstream also produced a second "ovsx" variant that additionally
bundles `iconv-lite` and `jschardet` — that one is for Open VSX and is not what
you want here.

## Install

Two locations, because this machine runs both desktop VSCode and a Remote
Tunnel server, each with its own extension directory.

```bash
CODE="/c/Users/$USER/AppData/Local/Programs/Microsoft VS Code/bin/code"
CS="/c/Users/$USER/.vscode-server/cli/servers/Stable-<hash>/server/bin/code-server.cmd"
VSIX='E:\code\svn-scm\svn-scm-<version>.vsix'   # whatever vsce just wrote

"$CODE" --install-extension "$VSIX" --force
"$CS"   --install-extension "$VSIX" --force
```

Pick `Stable-<hash>` from `~/.vscode-server/cli/servers/` — the most recent one,
which matches the `code-<hash>.exe` next to it. All server versions share the
single `~/.vscode-server/extensions` directory, so any recent CLI works.

Confirm both:

```bash
"$CODE" --list-extensions --show-versions | grep svn
"$CS"   --list-extensions --show-versions | grep svn
```

Uninstalling deregisters the extension in `extensions.json` but leaves its
directory on disk, recorded in `extensions/.obsolete`. VSCode removes it on its
own schedule — do not delete it by hand.

Reload the window afterwards; VSCode does not hot-swap an extension.

## Verify

Open the SVN output channel (`SVN: Show Output`) and watch the commands.

| Action | Expected |
| --- | --- |
| Left-click a modified file in Source Control | `svn info`, plus `svn cat -r BASE` the first time that file is opened |
| Open a plain file editor | `svn info` and `svn cat` (no `-r`) |

Neither should produce `svn list` or `svn stat`. If either appears, the local-ref
check in `SvnFileSystemProvider.stat()` is not matching — that is the regression
to look for.

## Divergence from upstream

- **Version 99.0.0.** The marketplace publishes 2.17.0. Any higher number stops
  VSCode from replacing this build with the published one; a deliberately absurd
  one also makes it unmistakable in `--list-extensions --show-versions` that
  this is not a marketplace build. Switching back to the marketplace build
  requires uninstalling this one first.
- **`SvnFileSystemProvider.stat()` no longer calls `repository.list()` for
  revisions served from the local pristine store.** See commit
  `perf: skip svn list in FileSystemProvider.stat for local revisions` for the
  reasoning; the short version is that the call was a network round trip for
  metadata the working copy already had, and it cascaded into a
  full-working-copy `svn stat` on every file open.

  Consequence worth remembering: that cascade was also the implicit status
  refresh. `svn.autorefresh` (default `true`) is the intended mechanism instead,
  and it is rate limited — 1s debounce, throttle, and a 5s tail.

  Do **not** add `files.watcherExclude` entries covering the working copy. The
  fixed `mtime` this change returns means document invalidation depends entirely
  on `.svn/` watcher events reaching `fireChangeEvents()`.

- **`svn.ignoreRepositories` accepts relative paths.** Upstream compared entries
  by exact normalized-string equality against an absolute fsPath, so only
  absolute entries matched and relative ones failed silently. Entries are now
  resolved against the workspace folder that owns the setting, which makes a
  committed `.vscode/settings.json` portable across machines:

  ```json
  { "svn.ignoreRepositories": ["./client/represent/rl"] }
  ```

  Still exact-match only - ignoring a directory does not ignore nested
  repositories underneath it, and globs are not supported.

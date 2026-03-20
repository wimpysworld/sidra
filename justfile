# List available recipes
default:
    @just --list

# Install project dependencies
install:
    npm install
    @just _fix-frameworks

# Restore macOS framework symlinks broken by extract-zip during npm install
[macos]
[private]
_fix-frameworks:
    #!/usr/bin/env bash
    set -euo pipefail
    frameworks_dir="node_modules/electron/dist/Electron.app/Contents/Frameworks"
    if [ ! -d "$frameworks_dir" ]; then
        exit 0
    fi
    for fw in "$frameworks_dir"/*.framework; do
        if [ -d "$fw/Versions/A" ] && [ ! -L "$fw/Versions/Current" ]; then
            ln -sf A "$fw/Versions/Current"
            name=$(basename "$fw" .framework)
            # Symlink the main binary
            if [ -e "$fw/Versions/A/$name" ] && [ ! -L "$fw/$name" ]; then
                ln -sf "Versions/Current/$name" "$fw/$name"
            fi
            # Symlink Resources if present
            if [ -d "$fw/Versions/A/Resources" ] && [ ! -L "$fw/Resources" ]; then
                ln -sf "Versions/Current/Resources" "$fw/Resources"
            fi
            # Symlink Libraries if present
            if [ -d "$fw/Versions/A/Libraries" ] && [ ! -L "$fw/Libraries" ]; then
                ln -sf "Versions/Current/Libraries" "$fw/Libraries"
            fi
            # Symlink Helpers if present
            if [ -d "$fw/Versions/A/Helpers" ] && [ ! -L "$fw/Helpers" ]; then
                ln -sf "Versions/Current/Helpers" "$fw/Helpers"
            fi
        fi
    done

[linux]
[private]
_fix-frameworks:

# Build TypeScript to dist/
build: _fix-frameworks
    npx tsc

# Run the app (builds first)
run: build
    npx electron .

# Run with debug logging to file
run-debug: build
    ELECTRON_LOG_LEVEL=debug npx electron .

# Run with DevTools open (builds first)
run-devtools: build
    SIDRA_DEVTOOLS=1 npx electron .

# Run with debug logging and DevTools (builds first)
run-inspect: build
    ELECTRON_LOG_LEVEL=debug SIDRA_DEVTOOLS=1 npx electron .

# Run without building (use after initial build for faster iteration)
run-fast:
    npx electron .

# Watch TypeScript for changes and rebuild
watch:
    npx tsc --watch

# Run linters
lint:
    @actionlint
    npx tsc --noEmit

# Validate electron-builder configuration
test:
    @ELECTRON_SKIP_BINARY_DOWNLOAD=1 node scripts/validate-build-config.cjs

# Clean build artefacts
clean:
    rm -rf dist/

# Build a package for the current platform
package: build
    npx electron-builder {{ if os() == "linux" { "--linux AppImage" } else if os() == "macos" { "--mac dmg" } else { "error('Unsupported platform')" } }}

# Show log file location and tail recent entries
logs:
    @echo "Log file: ~/.config/sidra/logs/main.log"
    @tail -50 ~/.config/sidra/logs/main.log 2>/dev/null || echo "No log file yet. Run the app first."

# Cut a release: just release 1.2.3
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ ! "{{VERSION}}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: VERSION must be semver (e.g. 1.2.3)" >&2
        exit 1
    fi

    branch=$(git branch --show-current)
    if [[ "$branch" != "main" ]]; then
        echo "Error: must be on main branch (currently on $branch)" >&2
        exit 1
    fi
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "Error: working tree is dirty" >&2
        exit 1
    fi

    npm version "{{VERSION}}" --no-git-tag-version

    git add package.json package-lock.json
    git commit -m "release: v{{VERSION}}"
    git tag "{{VERSION}}"

    echo "Release {{VERSION}} prepared. Push with:"
    echo "  git push origin main {{VERSION}}"


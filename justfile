# List available recipes
default:
    @just --list

# Install project dependencies
install:
    npm install
    @just _fix-frameworks
    @just _sign-evs

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

# Apply CastLabs EVS VMP signing to local Electron binary
[macos]
[private]
_sign-evs:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "node_modules/electron/dist/Electron.app" ]; then
        exit 0
    fi
    uvx --from castlabs-evs evs-vmp sign-pkg node_modules/electron/dist

[linux]
[private]
_sign-evs:

# Build TypeScript to dist/
build: _fix-frameworks _sign-evs
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

# Run with CDP exposed for Playwright attach (builds first)
run-cdp PORT="9222": build
    npx electron . --remote-debugging-port={{PORT}} --remote-debugging-address=127.0.0.1

# Run with CDP, debug logging, and DevTools (builds first)
run-cdp-inspect PORT="9222": build
    ELECTRON_LOG_LEVEL=debug SIDRA_DEVTOOLS=1 npx electron . --remote-debugging-port={{PORT}} --remote-debugging-address=127.0.0.1

# Run with CDP without building (use after initial build for faster iteration)
run-cdp-fast PORT="9222":
    npx electron . --remote-debugging-port={{PORT}} --remote-debugging-address=127.0.0.1

# Watch TypeScript for changes and rebuild
watch:
    npx tsc --watch

# Run linters
lint:
    @actionlint
    npx tsc --noEmit

# Run tests
test:
    npm test

# Validate electron-builder configuration
validate:
    @ELECTRON_SKIP_BINARY_DOWNLOAD=1 node scripts/validate-build-config.cjs
    npm audit

# Generate tray icon PNGs from SVG source
generate-tray-icon:
    #!/usr/bin/env bash
    set -euo pipefail
    src="assets/source/sidra-mini.svg"
    out="assets/icons"
    # macOS Template icons (black on transparent, macOS handles theme adaptation)
    rsvg-convert -w 16 -h 16 -o "$out/sidraTemplate.png" "$src"
    rsvg-convert -w 32 -h 32 -o "$out/sidraTemplate@2x.png" "$src"
    # Linux/Windows light theme (black on transparent)
    rsvg-convert -w 24 -h 24 -o "$out/sidra-tray-light.png" "$src"
    rsvg-convert -w 48 -h 48 -o "$out/sidra-tray-light@2x.png" "$src"
    rsvg-convert -w 24 -h 24 -o "$out/sidra-tray.png" "$src"
    rsvg-convert -w 48 -h 48 -o "$out/sidra-tray@2x.png" "$src"
    # Linux/Windows dark theme (white on transparent)
    sed 's/<svg /<svg fill="#FFFFFF" /' "$src" \
        | rsvg-convert -w 24 -h 24 -o "$out/sidra-tray-dark.png"
    sed 's/<svg /<svg fill="#FFFFFF" /' "$src" \
        | rsvg-convert -w 48 -h 48 -o "$out/sidra-tray-dark@2x.png"
    optipng -strip all -o7 -quiet \
        "$out/sidraTemplate.png" \
        "$out/sidraTemplate@2x.png" \
        "$out/sidra-tray-light.png" \
        "$out/sidra-tray-light@2x.png" \
        "$out/sidra-tray-dark.png" \
        "$out/sidra-tray-dark@2x.png" \
        "$out/sidra-tray.png" \
        "$out/sidra-tray@2x.png"

# Generate tray menu icon PNGs from SVG sources
generate-menu-icons:
    #!/usr/bin/env bash
    set -euo pipefail
    src="assets/source/tray-menu"
    for svg in "$src"/*.svg; do
        name=$(basename "$svg" .svg)
        for variant in light dark; do
            dir="assets/icons/tray/menu/$variant"
            mkdir -p "$dir"
            if [ "$variant" = "dark" ]; then
                sed 's/<svg /<svg fill="#FFFFFF" /' "$svg" \
                    | rsvg-convert -w 18 -h 18 -o "$dir/$name.png"
                sed 's/<svg /<svg fill="#FFFFFF" /' "$svg" \
                    | rsvg-convert -w 36 -h 36 -o "$dir/$name@2x.png"
            else
                rsvg-convert -w 18 -h 18 -o "$dir/$name.png" "$svg"
                rsvg-convert -w 36 -h 36 -o "$dir/$name@2x.png" "$svg"
            fi
            optipng -strip all -o7 -quiet "$dir/$name.png" "$dir/$name@2x.png"
        done
    done

# Clean build artefacts
clean:
    rm -rf dist/

# Clear all Sidra user data and caches
[macos]
clear:
    rm -rf ~/Library/Application\ Support/Sidra
    rm -rf ~/Library/Caches/Sidra
    rm -rf ~/Library/Logs/Sidra
    @echo "Sidra data cleared"

# Clear all Sidra user data and caches
[linux]
clear:
    rm -rf ~/.config/sidra
    rm -rf ~/.cache/sidra
    @echo "Sidra data cleared"

# Build a package for the current platform
package: build
    #!/usr/bin/env bash
    set -euo pipefail

    base_version=$(node -p "require('./package.json').version")
    commit_count=$(git rev-list --count HEAD)
    short_hash=$(git rev-parse --short HEAD)
    dev_version="${base_version}-dev.${commit_count}.${short_hash}"

    trap 'npm version "$base_version" --no-git-tag-version --allow-same-version >/dev/null 2>&1' EXIT

    npm version "$dev_version" --no-git-tag-version --allow-same-version
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

    version="{{VERSION}}"

    branch=$(git branch --show-current)
    if [[ "$branch" != "main" ]]; then
        echo "Error: must be on main branch (currently on $branch)" >&2
        exit 1
    fi

    # Check if tag already exists
    if git rev-parse "$version" >/dev/null 2>&1; then
        echo "Error: Tag $version already exists" >&2
        exit 1
    fi

    # Bump package.json version if needed
    current_version=$(node -p "require('./package.json').version")
    if [[ "$current_version" != "$version" ]]; then
        npm version "$version" --no-git-tag-version
        git add package.json package-lock.json
        git commit -m "chore(release): bump version to $version" -- package.json package-lock.json
        echo "✓ Version bumped to $version"
    else
        echo "✓ Version already at $version"
    fi

    echo "Creating release $version..."
    git tag -a "$version" -m "v$version"
    echo "✓ Tag $version created"
    echo ""
    echo "To publish the release:"
    echo "  git push origin $version"
    echo ""
    echo "This will trigger the GitHub Actions release workflow which will:"
    echo "  - Build binaries for all platforms"
    echo "  - Generate changelog from commits"
    echo "  - Create GitHub release with downloadable assets"

# List available recipes
default:
    @just --list

# Install project dependencies
install:
    npm install

# Build TypeScript to dist/
build:
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

# Clean build artefacts
clean:
    rm -rf dist/

# Show log file location and tail recent entries
logs:
    @echo "Log file: ~/.config/sidra/logs/main.log"
    @tail -50 ~/.config/sidra/logs/main.log 2>/dev/null || echo "No log file yet. Run the app first."


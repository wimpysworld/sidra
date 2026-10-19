# Managed by Tailor: just/tailor.just

# Alter Tailor swatches
alter:
    @tailor alter

# Run all enabled builders
build:
    @echo "No build recipes are enabled."

# Run all enabled tests
test:
    @echo "No test recipes are enabled."

# Run workflow linters
lint-actions:
    @actionlint

# Run all enabled linters
lint: lint-actions

# Preview remote and local changes, then inspect local project health
measure:
    @tailor baste
    @tailor measure

# Create a local release tag with just release x.y.z
release $VERSION:
    #!/usr/bin/env bash
    set -e

    if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "Error: VERSION must be in format x.y.z (e.g., 0.1.0)"
        exit 1
    fi

    # Require a clean checkout so that the tag matches the local source files.
    if [ -n "$(git status --porcelain)" ]; then
        echo "Error: Working directory is not clean"
        exit 1
    fi

    if git show-ref --tags --verify --quiet "refs/tags/v${VERSION}"; then
        echo "Error: Tag v${VERSION} already exists"
        exit 1
    fi

    echo "Creating release v${VERSION}..."
    git tag -a "v${VERSION}" -m "v${VERSION}"
    echo "Tag v${VERSION} created"
    echo ""
    echo "To publish the release:"
    echo "  git push origin v${VERSION}"
    echo ""

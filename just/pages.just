# Managed by Tailor: just/pages.just

# Preview the Pages site at http://127.0.0.1:18473
pages:
    #!/usr/bin/env bash
    set -e
    site="pages"
    if [ ! -f "${site}/index.html" ]; then
        echo "Error: preview requires \"pages/index.html\". Add that file first." >&2
        exit 1
    fi
    miniserve --index index.html --interfaces 127.0.0.1 --port 18473 "${site}"

# Managed by Tailor: just/tailor.just

# Run explicitly requested setup for enabled components
setup:
    @echo "No setup recipes are enabled."

# Build all enabled ecosystems
build:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "No build recipes are enabled."
    project_script='just/project/build.sh'
    for parent in just just/project; do
        if [[ -L "${parent}" || ( -e "${parent}" && ! -d "${parent}" ) ]]; then
            echo "Error: project script parent ${parent} must be a directory, not a symlink" >&2
            exit 1
        fi
    done
    if [[ -L "${project_script}" || ( -e "${project_script}" && ! -f "${project_script}" ) ]]; then
        echo "Error: project script ${project_script} must be a regular file, not a symlink" >&2
        exit 1
    fi
    if [[ -f "${project_script}" ]]; then
        bash "${project_script}"
    fi

# Run full vet and tests with console coverage
test:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "No test recipes are enabled."
    project_script='just/project/test.sh'
    for parent in just just/project; do
        if [[ -L "${parent}" || ( -e "${parent}" && ! -d "${parent}" ) ]]; then
            echo "Error: project script parent ${parent} must be a directory, not a symlink" >&2
            exit 1
        fi
    done
    if [[ -L "${project_script}" || ( -e "${project_script}" && ! -f "${project_script}" ) ]]; then
        echo "Error: project script ${project_script} must be a regular file, not a symlink" >&2
        exit 1
    fi
    if [[ -f "${project_script}" ]]; then
        bash "${project_script}"
    fi

# Check source without changes, or tidy and format with correct
lint $mode="check":
    #!/usr/bin/env bash
    set -euo pipefail
    case "${mode}" in
        check|correct) ;;
        *) echo "Error: lint mode must be check or correct" >&2; exit 1 ;;
    esac
    for tool in git mktemp rm grep node oxlint prettier; do
        if ! command -v "${tool}" >/dev/null 2>&1; then
            echo "Error: source lint requires ${tool} on PATH" >&2
            exit 1
        fi
    done
    source_regular() {
        local source="$1" parent
        parent="${source%/*}"
        while [[ "${parent}" != . ]]; do
            if [[ -L "${parent}" || ! -d "${parent}" ]]; then
                echo "Error: source parent ${parent} must be a directory, not a symlink" >&2
                exit 1
            fi
            parent="${parent%/*}"
        done
        if [[ -L "${source}" || ! -f "${source}" ]]; then
            echo "Error: source ${source} must be a regular file, not a symlink" >&2
            exit 1
        fi
    }
    source_generated() {
        local line comment remainder block=false count=0
        local marker='(^|[[:space:]])(@generated|code generated|do not edit)'
        while (( count < 50 )) && { IFS= read -r line || [[ -n "${line}" ]]; }; do
            (( count += 1 ))
            line="${line#"${line%%[![:space:]]*}"}"
            remainder=''
            if "${block}"; then
                comment="${line}"
            else
                case "${line}" in
                    '') continue ;;
                    '#!'*) continue ;;
                    '#'* ) comment="${line#?}" ;;
                    '//'*) comment="${line#??}" ;;
                    '/*'*) block=true; comment="${line#??}" ;;
                    *) break ;;
                esac
            fi
            if "${block}" && [[ "${comment}" == *'*/'* ]]; then
                remainder="${comment#*\*/}"
                comment="${comment%%\*/*}"
                block=false
            fi
            if grep -Eiq -- "${marker}" <<< "${comment}"; then return 0; fi
            if [[ "${remainder}" == *[![:space:]]* ]]; then break; fi
        done < "$1"
        return 1
    }
    javascript_files=()
    shell_files=()
    source_paths="$(mktemp)"
    trap 'rm -f -- "${source_paths}"' EXIT
    git ls-files --cached --others --exclude-standard -z > "${source_paths}"
    while IFS= read -r -d '' source; do
        case "/${source}" in
            */.git/*|*/.cache/*|*/.next/*|*/.nuxt/*|*/.svelte-kit/*|*/.output/*|*/node_modules/*|*/vendor/*|*/third_party/*|*/third-party/*|*/generated/*|*/dist/*|*/build/*|*/coverage/*|*/target/*|*/result/*|*/credentials/*|*/secrets/*) continue ;;
            */.env|*/.env.*|*/.prettierrc|*/.prettierrc.*|*/.eslintrc|*/.eslintrc.*|*/.babelrc|*/.babelrc.*|*/.oxlintrc.json|*/.shellcheckrc|*/.editorconfig|*.config.*|*.generated.*|*.gen.*|*.min.*|*-min.*|*_min.*|*.d.ts|*.d.mts|*.d.cts) continue ;;
        esac
        if [[ -d "${source}" && ! -L "${source}" ]]; then
            indexed_source="$(git --literal-pathspecs ls-files --stage -- "${source}")"
            if [[ -z "${indexed_source}" || "${indexed_source}" == '160000 '* ]]; then continue; fi
        fi
        javascript_source=false
        shell_source=false
        case "${source}" in
            *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts) javascript_source=true ;;
            *.sh|*.bash) shell_source=false ;;
            *)
                if false && [[ "${source##*/}" != *.* ]]; then
                    shell_source=true
                fi ;;
        esac
        if ! "${javascript_source}" && ! "${shell_source}"; then
            continue
        fi
        if git check-ignore --no-index -q -- "${source}"; then
            continue
        else
            status=$?
            if (( status != 1 )); then exit "${status}"; fi
        fi
        if [[ ! -e "${source}" && ! -L "${source}" ]]; then continue; fi
        source_regular "./${source}"
        first_line=''
        IFS= read -r first_line < "${source}" || true
        if "${shell_source}"; then
            shell_shebang='^#![[:blank:]]*(/[^[:blank:]]*/(ba)?sh|/[^[:blank:]]*/env[[:blank:]]+(-S[[:blank:]]+)?(ba)?sh)([[:blank:]]|$)'
            if [[ "${first_line}" == '#!'* || "${source##*/}" != *.* ]]; then
                if [[ ! "${first_line}" =~ ${shell_shebang} ]]; then continue; fi
            fi
        fi
        if source_generated "./${source}"; then continue; fi
        if "${javascript_source}"; then javascript_files+=("./${source}"); fi
        if "${shell_source}"; then shell_files+=("./${source}"); fi
    done < "${source_paths}"
    rm -f -- "${source_paths}"
    trap - EXIT
    check_workflows() {
        for workflow in .github/workflows/* .github/workflows/.*; do
            case "${workflow}" in *.yml|*.yaml)
                if [[ -f "${workflow}" ]]; then
                    actionlint
                    return
                fi ;;
            esac
        done
        echo "No GitHub Actions workflows found. Skipping actionlint."
    }
    check_workflows
    (
    if (( ${#javascript_files[@]} == 0 )); then
        echo "No eligible JavaScript/TypeScript source files found. Use just/project/lint.sh for additional checks."
    else
        if [[ "${mode}" == correct ]]; then
            for source in "${javascript_files[@]}"; do source_regular "${source}"; done
            prettier --write -- "${javascript_files[@]}"
        fi
        oxlint --deny-warnings --no-error-on-unmatched-pattern -- "${javascript_files[@]}"
        prettier --check -- "${javascript_files[@]}"
    fi
    )
    project_script='just/project/lint.sh'
    for parent in just just/project; do
        if [[ -L "${parent}" || ( -e "${parent}" && ! -d "${parent}" ) ]]; then
            echo "Error: project script parent ${parent} must be a directory, not a symlink" >&2
            exit 1
        fi
    done
    if [[ -L "${project_script}" || ( -e "${project_script}" && ! -f "${project_script}" ) ]]; then
        echo "Error: project script ${project_script} must be a regular file, not a symlink" >&2
        exit 1
    fi
    if [[ -f "${project_script}" ]]; then
        bash "${project_script}" "${mode}"
    fi

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

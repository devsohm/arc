# Resource discovery

`loadResources({ cwd, home, paths })` returns the instruction files, skill metadata, prompt templates, and extension entry files for an application session. `home` is the application resource directory. Its default is `~/.arc`.

| Resource | Personal location | Project location |
| --- | --- | --- |
| Instructions | `home/AGENTS.md` | `AGENTS.md` in each ancestor directory and `cwd` |
| Skills | `home/skills` | `cwd/.arc/skills` |
| Prompt templates | `home/prompts` | `cwd/.arc/prompts` |
| Extension entries | `home/extensions` | `cwd/.arc/extensions` |

Instruction files load in order, starting with the personal file, then directories from the filesystem root through `cwd`. A symlink to an already loaded file does not add that file again. Files below `cwd` do not load automatically.

The other resource directories belong to the current project and the application home. Discovery does not search ancestor `.arc` folders or arbitrary project directories. Missing optional files and directories are allowed. Unreadable resources and invalid metadata produce errors with the affected path.

Optional `paths` entries add resource roots with their own `skills`, `prompts`, and `extensions` directories. Relative paths resolve against `cwd`. Explicit roots take precedence over project and personal skills and templates. The first explicit root wins duplicate names. Their extension files follow the personal and project files. Explicit roots do not add instruction files.

## Skill metadata

A skill directory contains `SKILL.md` with YAML frontmatter:

```markdown
---
name: release-check
description: Check the release changes and the project validation results.
---

Read the release checklist in references/checklist.md before reviewing a release.
```

`description` is a required, nonempty string. `name` is an optional, nonempty string without whitespace or a slash. The directory name supplies a missing name. Quoted and multiline YAML strings are supported. Unknown frontmatter fields do not affect discovery.

Discovery searches the skill directory recursively. A directory with its own `SKILL.md` ends that search branch. Hidden directories, `node_modules`, and standalone Markdown files are skipped. Directory symlinks are followed once per physical directory, so cycles terminate.

Project skills override personal skills with the same name. Within one location, the first file found in lexical directory order wins. The returned list is sorted by name and contains each command name once.

Only names, descriptions, and file paths enter the initial system prompt. The model reads a skill file when its description matches the request. Relative references belong to the directory containing that file. `promptForSkill(skill, args)` creates an explicit request to read and apply that skill, followed by the unmodified request text.

## Prompt templates

Direct `.md` children of a prompt directory become commands named after their filenames. Nested files and hidden files are skipped. Optional YAML frontmatter supplies a `description`. Without a description, the first nonempty body line supplies it. The returned `content` excludes frontmatter and surrounding whitespace.

Project templates override personal templates with the same name. Each physical file appears once, including symlink aliases. The first filename in lexical order wins within one location. Templates in the returned list are sorted by name.

`expandPrompt(content, args)` accepts arguments with single quotes, double quotes, and backslash escapes. Adjacent quoted and unquoted text forms one argument. An unfinished quote or escape produces a syntax error.

| Placeholder | Expansion |
| --- | --- |
| `$1`, `$2` | A positional argument, starting at one |
| `$@`, `$ARGUMENTS` | All arguments joined with spaces |
| `${1:-fallback}` | The argument, or `fallback` when missing or empty |
| `${@:-fallback}`, `${ARGUMENTS:-fallback}` | All arguments, or `fallback` when empty |
| `${@:2}` | Arguments starting at position two |
| `${@:2:3}` | Up to three arguments starting at position two |

Unknown placeholders remain literal. Missing positional arguments expand to empty strings. Expansion makes one pass, so argument values and fallback text cannot introduce another substitution. It never executes a command.

## Extension entries

Discovery returns paths without importing or executing modules. Direct `.ts`, `.mts`, `.mjs`, and `.js` files qualify. TSX files must be compiled to JavaScript before discovery. An immediate child directory can supply an `index` file with one of those suffixes, in the order shown. Helper modules below that directory do not become separate entries.

Declaration files, hidden entries, `node_modules`, and CommonJS entry files are excluded. Personal entries load before project entries. Each location uses lexical entry order, and physical files are deduplicated across locations. The application passes these files to Durable's extension loader.

## Prompt extension

`createPromptExtension(resources, cwd, options)` creates a Durable `Extension`. The extension renders the tools offered by the active agent on each turn, including custom descriptions. Guidance for reading, editing, writing, and shell commands appears only when the corresponding tool is offered. The skill catalog appears when `read` or `bash` is offered.

`options.systemPrompt` replaces the default role and work guidance. Tool descriptions, instruction files, skill metadata, and the working directory remain separate sections. `options.appendSystemPrompt` adds a separate section. The agent's configured working directory takes precedence over the fallback `cwd`.

Reinstalling a new extension with the same name updates its resources. Durable records changed and removed sections on the next model request.

Run the discovery and request tests with:

```sh
npx vitest run packages/cli/test/resources.test.ts packages/cli/test/prompt.test.ts
```

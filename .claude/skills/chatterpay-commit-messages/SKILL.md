---
name: chatterpay-commit-messages
description: Inspect real pending Git file changes in the ChatterPay Analytics API and print one git add plus git commit command per file without executing them.
argument-hint: "[repo] [issue-id-or-none]"
disable-model-invocation: true
---

Task arguments: $ARGUMENTS

Read the ChatterPay workflows reference first. Prefer `<repo-root>/.claude/docs/chatterpay-workflows-reference.md`; otherwise `~/.claude/docs/chatterpay-workflows-reference.md`. Apply `<repo-root>/.claude/rules/chatterpay-workflows.md`. If no reference is available, request it rather than inventing details.

Identify the current Git repo (`chatterpay/chatterpay-b2c-analytics-api`) and ask the user to confirm it. Ask for the task/issue ID unless given or confirmed absent; issue numbers of the site repo do not apply here. Inspect `git status`, staged and unstaged diffs, and the content of untracked files. The commit format comes from `AGENTS.md` (`[type] :gitmoji: message`) and the types and icons from the catalog in the reference.

Run `yarn lint:ci`, `yarn type-check`, `yarn test` and `yarn openapi:check`. Report any failure next to the commands. Warn when routes or schemas changed without a regenerated `openapi/openapi.yaml`, or when the mock generator output changed without a new `DATASET_VERSION`. Do not run `yarn pre-commit`, `yarn lint:fix` or `yarn openapi`: they rewrite files.

For **each changed logical file**, print one **plain-text** line in this form: `git add -- "path"; git commit -m "[type] :icon: Imperative English description (#123)"`. Omit `(#123)` only if the user confirms no issue exists. Keep the entire subject <=80 characters. Use literal brackets and Gitmoji colon codes. Select type and icon from the change's purpose, not the extension alone. Warn when the current index contains staged changes from other tasks that would contaminate separate commits.

**Hard prohibition:** Do not run `git add`, `git commit`, `git push`, any other Git mutation, or write code/files. Never use `git add .`. Output commands only.

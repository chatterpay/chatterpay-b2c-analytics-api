---
name: chatterpay-pr-texts
description: Generate evidence-based PR change descriptions for the ChatterPay Analytics API grouped by repository and issue, and print them in the console.
argument-hint: "[repo-scope] [issue-ids-or-urls]"
disable-model-invocation: true
---

Task arguments: $ARGUMENTS

Read the ChatterPay workflows reference first. Prefer `<repo-root>/.claude/docs/chatterpay-workflows-reference.md`; otherwise `~/.claude/docs/chatterpay-workflows-reference.md`. Apply `<repo-root>/.claude/rules/chatterpay-workflows.md`.

Identify the repo(s) actually worked on and the PR diff or confirmed merge-base. Gather verified commits, files, tests and contract changes (`openapi/openapi.yaml`) and only task-related operational evidence. Resolve task/issue IDs; ask if any are missing. Do not confuse equal issue numbers of the API and the site.

Print in the console Markdown grouped by repository (`## <owner>/<repo>`), with per-task headings exactly `### Changes related to #123`, followed by precise English past-tense bullets. Mock metrics are described as synthetic data. Avoid unverified claims. Do not write the output to any file.

Do not edit source code, commit, push, create PRs, deploy or mutate the database or GCP. Report any unresolved evidence.

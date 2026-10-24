---
name: chatterpay-deploy-texts
description: Update the ChatterPay Analytics develop and main deployment notes by verified task/issue without deploying anything.
argument-hint: "[issue-ids-or-urls] [develop|main|both] [notes-paths]"
disable-model-invocation: true
---

Task arguments: $ARGUMENTS

Read the ChatterPay workflows reference first. Prefer `<repo-root>/.claude/docs/chatterpay-workflows-reference.md`; otherwise `~/.claude/docs/chatterpay-workflows-reference.md`. Apply `<repo-root>/.claude/rules/chatterpay-workflows.md`.

Resolve issue IDs and GitHub issue URLs/titles in the repository that owns each task (`chatterpay/chatterpay-analytics-api` or `chatterpay/chatterpay-analytics-site`); ask for missing IDs. Inspect real diffs and completed task evidence, and ask whether the note belongs to develop, main or both when unknown.

The repo does not define where the deploy notes live: take the develop and main notes paths from the arguments or ask the operator. Verify that both files exist and read them completely before writing; never create them and never read or list other files in their folder.

Update **only** the relevant portions of those two Markdown files, organized by verified issue URL and component (`API`, `Site`, `GCP`, `Database`, `Configuration`, `Deployment`). Notes hold the changes only: code, the OpenAPI contract, `DATASET_VERSION`, MongoDB collections and indexes of the analytics database, configuration and GCP resources such as Cloud Run services, Cloud Build triggers, `roles/run.invoker` bindings, Secret Manager secrets and environment variable names. No status, procedures, commands or local paths. Preserve other entries and avoid duplicate task sections. Never write secret values and never claim a GCP or database change without evidence.

Report edits for each file and any evidence gaps. **No** commits, pushes, PR creation, deploys, external mutations or other code edits.

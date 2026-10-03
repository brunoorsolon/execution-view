---
name: execution-view-issues
description: Use when writing or editing an issue in a repository execution-view reads, especially when adding blockers or a parent, so the relations parse in every dependencies.body mode.
---

# Writing issues execution-view reads

Write each relation on its own relation line. Relation lines are read in every `dependencies.body` mode; no other line form is read in every mode.

- Declare blockers on the blocked issue: `Blocked by: [#12, owner/repo#4]`. Text after the `]` is a note for humans.
- Declare the hierarchy on the child: `Parent: [#71]`. A parent never blocks anything.
- Write relations in the issue body, never in a comment.
- Inside the brackets, use only `#N` (same repository), `owner/repo#N`, or an issue URL on the tracker's own host.
- Under a heading named `Dependencies`, `Blocked by`, `Depends on`, `Requires` or `Blocks`, write only relation lines. The default mode reads any other bullet there that mentions an issue as a relation.

One complete example:

```md
## What

Add the export command.

## Relations

- Parent: [#71] the spec this belongs to
- Blocked by: [#12, owner/repo#4] both land first
```

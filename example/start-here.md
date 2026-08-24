# Start Here

This small public corpus exercises the main publishing surfaces without using
personal notes or identity.

## One target, several link forms

These links all resolve to the same published note:

- basename: [[feature-showcase]]
- relative path: [[./guides/feature-showcase]]
- repository path: [[guides/feature-showcase]]
- labelled wikilink: [[guides/feature-showcase|the feature showcase]]
- Markdown link: [the same note](guides/feature-showcase.md)

A note embed is deliberately downgraded to a normal link instead of transcluding
another note's body: ![[guides/feature-showcase]]

## Withheld targets

The following links remain live, but both lead to `/private/` and neither target
body is published:

- frontmatter exclusion: [[withheld/frontmatter-note]]
- configuration glob: [[drafts/glob-excluded]]

## What to inspect

Open search, the graph, tags, and the `guides` collection. The linked feature
note also links back here, so both pages expose outgoing links and backlinks.

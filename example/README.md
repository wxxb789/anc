# Example content

This directory is a small synthetic Markdown repository for local verification,
evaluation, and feature demonstrations. It contains no personal content.

From the project root:

```bash
pnpm run build:example
pnpm run preview:example
```

The build is written to `.tmp/example-dist/`. This README is intentionally not
published: a `README.md` at the content root is skipped by default.

The corpus demonstrates:

- default publication and rich frontmatter;
- tags, a collection, aliases, search, feed entries, backlinks, and graph edges;
- GFM, callouts, highlighted code, math, Mermaid, and footnotes;
- Obsidian-style links, Markdown links, and note embeds;
- withholding through both `publish: false` and an exclusion glob.

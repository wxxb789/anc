# Kitchen Sink

Synthetic fixture exercising every construct the pipeline supports. Nothing here
comes from the private vault.

## Prose and inline marks

Regular text with **bold**, *emphasis*, ~~strikethrough~~, `inline code`, and a
[public link](https://example.com/docs/). Prices such as $5 to $10 stay literal.

混合 Mixed 中文 heading text appears below.

## 混合 Mixed 标题

### Nested subsection

## Tables

| Language | Runs at | Notes |
|:---------|:-------:|------:|
| Markdown | build   | safe  |
| Mermaid  | build   | plain |

## Task list

- [ ] Unchecked item
- [x] Checked item

## Callouts

> [!note] Callout with a title
> Callout body with **bold** inside.

> [!warning]
> Callout without a title.

> An ordinary blockquote that is not a callout.

## Code

```js
const answer = 41 + 1;
```

```mermaid
graph TD; A-->B;
```

```
plain fence with no language
```

## Math

$$
E = mc^2
$$

## Images

![](decorative.png)

![A described diagram](https://example.com/diagram.png)

## Links

An [internal note link](/other-note/), an [internal heading link](/other-note/#a-heading),
and an [external link](https://example.com/).

## Footnotes

A claim needing a source.[^src]

[^src]: The synthetic source note.

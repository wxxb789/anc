/**
 * The slice of `css-tree` 3.2.1 this build uses.
 *
 * The package ships no declarations of its own (measured: no `types` field, no
 * `.d.ts` anywhere in the tarball), and it is a pinned build-time policy parser
 * rather than an application dependency. A local declaration of exactly the API
 * `src/lib/svg-css.ts` calls is smaller than a third package and cannot drift
 * wider than its consumer: adding a call the parser does not have fails here
 * before it fails at run time.
 *
 * `CssNode` is deliberately structural rather than exhaustive. The policy walks
 * the AST and asks each node four questions — what type is it, what is its name,
 * what URL does a `Url` node carry, and what child list, selector or declaration
 * block does a container carry — so those are the only members declared.
 * Anything else is read through the `unknown` index and must be narrowed by the
 * caller.
 */
declare module 'css-tree' {
  export interface CssNode {
    readonly type: string;
    /** Function, identifier and pseudo-class names. */
    readonly name?: string;
    /** A `Url` node's decoded value, or a scalar node's textual value. */
    readonly value?: string;
    /** A list node's children; `css-tree` returns a `List` with `toArray()`. */
    readonly children?: { toArray(): CssNode[] };
    /** A `Rule`'s selector list. */
    readonly prelude?: CssNode;
    /** A `Rule`'s declaration block. */
    readonly block?: CssNode;
    readonly [member: string]: unknown;
  }

  export interface ParseOptions {
    /** `stylesheet`, `declarationList`, `value`, or another css-tree context. */
    readonly context?: string;
    readonly positions?: boolean;
    readonly parseValue?: boolean;
    readonly parseCustomProperty?: boolean;
    readonly onParseError?: (error: Error) => void;
  }

  export function parse(source: string, options?: ParseOptions): CssNode;

  export function walk(root: CssNode, visit: (node: CssNode) => void): void;
}

/**
 * Thrown when a diagram cannot be rendered safely. The build stops.
 *
 * A leaf module with no imports, kept separate from the renderer that throws it
 * (`pele-render.ts`) so that a consumer which only needs to recognise the class
 * — the refusal and failure rows in `tests/diagram-engine.test.ts` — loads
 * neither `pele` nor its parser dependencies. Nothing here may import anything:
 * the class is the one thing the renderer and its callers share, and a
 * dependency of its own would sit on every path that touches a diagram.
 *
 * It lived beside the engine switch (`diagram-mode.ts`) while the build had two
 * engines, so that neither adapter imported the other for one class; the switch
 * is gone and the class keeps its own home.
 */
export class DiagramError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${message}\n  in diagram: ${source.trim().slice(0, 200)}`);
    this.name = 'DiagramError';
    this.source = source;
  }
}

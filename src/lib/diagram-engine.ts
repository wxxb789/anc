import { DIAGRAM_ENGINE } from './diagram-mode.ts';

export async function renderDiagram(source: string, diagramId: string, accessibleName: string): Promise<string> {
  // Static imports would load the unselected engine, including Mermaid's DOM shim.
  switch (DIAGRAM_ENGINE) {
    case 'mermaid':
      return (await import('./mermaid-render.ts')).renderDiagram(source, diagramId, accessibleName);
    case 'pele':
      return (await import('./pele-render.ts')).renderDiagram(source, diagramId, accessibleName);
    default:
      throw new Error(`Unknown diagram engine: ${String(DIAGRAM_ENGINE)}`);
  }
}

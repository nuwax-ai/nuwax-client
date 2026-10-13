/** Small inline line icons: no fonts, external resources, or network in the private window. */
export function createCaptureIcon(name: string): SVGSVGElement {
  const paths: Record<string, string[]> = {
    select: ['m5 3 14 10-7 1-4 7z'],
    deleteAnnotation: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
    screen: ['M3 4h18v13H3z', 'M8 21h8M12 17v4'],
    window: ['M3 5h18v15H3z', 'M3 9h18M6 7h.01M9 7h.01'],
    region: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5', 'M8 8h8v8H8z'],
    rectangle: ['M4 5h16v14H4z'],
    ellipse: ['M21 12a9 7 0 1 1-18 0 9 7 0 1 1 18 0'],
    arrow: ['M4 20 20 4M9 4h11v11'],
    pen: ['m4 16-1 5 5-1L20 8a2.8 2.8 0 0 0-4-4L4 16z', 'm14 6 4 4M4 16l4 4'],
    text: ['M4 7V4h16v3M12 4v16M8 20h8'],
    mosaic: ['M3 3h6v6H3zM15 3h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zM15 15h6v6h-6z'],
    undo: ['M9 5 4 10l5 5', 'M4 10h10a6 6 0 0 1 0 12'],
    redo: ['m15 5 5 5-5 5', 'M20 10H10a6 6 0 0 0 0 12'],
    cancel: ['m6 6 12 12M18 6 6 18'],
    confirm: ['m4 12 5 5L20 6'],
    record: ['M20 12a8 8 0 1 1-16 0 8 8 0 1 1 16 0'],
    pause: ['M8 5v14M16 5v14'],
    resume: ['m7 4 13 8-13 8z'],
    stop: ['M5 5h14v14H5z'],
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const d of paths[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d);
    if (['record', 'stop', 'resume', 'mosaic'].includes(name)) path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

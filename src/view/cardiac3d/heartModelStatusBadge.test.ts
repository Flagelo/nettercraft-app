import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as HeartMesh from './HeartMesh17';

// Regression guard: the "Fallback Ativo" label previously appeared during normal GLB loading (gltfScene still null) without
// any error. The wireframe badge distinguishes "loading" from "failure". Render test of the badge component with react-dom/server:
// mounting HeartWireframeFallback/HeartElectromechanicalScene requires the R3F context with WebGL (useFrame, <Html>), unavailable in Node.
describe('Anatomical wireframe badge (loading × GLB failure)', () => {
  const badge = (HeartMesh as Record<string, unknown>).HeartModelStatusBadge as ((p: { status: 'loading' | 'failed' }) => React.ReactElement) | undefined;

  it('exists as an exported component', () => {
    expect(typeof badge).toBe('function');
  });

  it('during loading does not say "Fallback Ativo"', () => {
    const html = renderToStaticMarkup(React.createElement(badge!, { status: 'loading' }));
    expect(html).toMatch(/CARREGANDO/);
    expect(html).not.toMatch(/Fallback Ativo/);
  });

  it('on GLB failure keeps the "Fallback Ativo" label', () => {
    const html = renderToStaticMarkup(React.createElement(badge!, { status: 'failed' }));
    expect(html).toMatch(/Fallback Ativo/);
    expect(html).not.toMatch(/CARREGANDO/);
  });
});

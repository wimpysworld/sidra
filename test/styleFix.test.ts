import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const styleFixCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styleFix.css'), 'utf-8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function globalAmpChromePlayerBlocks(css: string): string[] {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(stripComments(css))) !== null) {
    const selectors = match[1].split(',').map(selector => selector.trim());
    if (selectors.includes('amp-chrome-player')) {
      blocks.push(match[2]);
    }
  }

  return blocks;
}

function containsPlayerEnlargement(declarations: string): boolean {
  const enlargementProperty = /(?:^|;)\s*(?:zoom|scale|width|height|min-width|min-height|inline-size|block-size|min-inline-size|min-block-size|padding|padding-block|padding-inline|gap)\s*:/i;
  const transformScale = /(?:^|;)\s*transform\s*:\s*[^;]*\bscale(?:3d|x|y|z)?\s*\(/i;

  return enlargementProperty.test(declarations) || transformScale.test(declarations);
}

describe('styleFix.css', () => {
  it('does not globally enlarge amp-chrome-player', () => {
    const forbiddenBlocks = globalAmpChromePlayerBlocks(styleFixCss)
      .filter(containsPlayerEnlargement);

    expect(forbiddenBlocks).toEqual([]);
  });
});

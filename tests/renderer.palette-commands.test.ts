import { describe, expect, it } from 'vitest';

import {
  buildRecentPaletteCommands,
  createPaletteCommands,
  filterPaletteCommands,
} from '../app/renderer/src/lib/rendererPalette.js';

describe('renderer palette command helpers', () => {
  it('annotates and sorts palette commands once', () => {
    const commands = createPaletteCommands([
      { label: 'Review Governance', hint: 'Inspect trust', run: () => {} },
      { label: 'Open Home', hint: 'Return home', run: () => {} },
    ]);

    expect(commands.map((command) => command.label)).toEqual(['Open Home', 'Review Governance']);
    expect(commands[0]?.normalizedLabel).toBe('open home');
    expect(commands[0]?.searchText).toContain('return home');
  });

  it('filters palette commands against precomputed search text', () => {
    const commands = createPaletteCommands([
      { label: 'Open Home', hint: 'Return to home', run: () => {} },
      { label: 'Review Governance', hint: 'Inspect trust', run: () => {} },
    ]);

    expect(filterPaletteCommands(commands, 'trust').map((command) => command.label)).toEqual(['Review Governance']);
    expect(filterPaletteCommands(commands, '').map((command) => command.label)).toEqual([
      'Open Home',
      'Review Governance',
    ]);
  });

  it('builds recent palette commands from a label index without duplicates', () => {
    const commands = createPaletteCommands([
      { label: 'Open Home', hint: 'Return to home', run: () => {} },
      { label: 'Review Governance', hint: 'Inspect trust', run: () => {} },
    ]);

    expect(
      buildRecentPaletteCommands([' review governance ', 'Open Home', 'Review Governance'], commands, '').map(
        (command) => command.label,
      ),
    ).toEqual(['Review Governance', 'Open Home']);
    expect(buildRecentPaletteCommands(['Open Home'], commands, 'trust')).toEqual([]);
  });
});

export type PaletteCommand = {
  label: string;
  hint: string;
  run: () => void;
  normalizedLabel: string;
  searchText: string;
};

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

export function createPaletteCommand(input: { label: string; hint: string; run: () => void }): PaletteCommand {
  return {
    ...input,
    normalizedLabel: normalizeText(input.label),
    searchText: `${input.label} ${input.hint}`.toLowerCase(),
  };
}

export function createPaletteCommands(
  commands: Array<{ label: string; hint: string; run: () => void }>,
): PaletteCommand[] {
  return commands
    .map((command) => createPaletteCommand(command))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function filterPaletteCommands(commands: PaletteCommand[], normalizedQuery: string): PaletteCommand[] {
  if (!normalizedQuery) {
    return commands;
  }

  return commands.filter((command) => command.searchText.includes(normalizedQuery));
}

export function buildRecentPaletteCommands(
  recentLabels: string[],
  commands: PaletteCommand[],
  normalizedQuery: string,
): PaletteCommand[] {
  const byLabel = new Map(commands.map((command) => [command.normalizedLabel, command] as const));
  const seen = new Set<string>();
  const results: PaletteCommand[] = [];

  for (const label of recentLabels) {
    const command = byLabel.get(normalizeText(label));
    if (!command || seen.has(command.label)) {
      continue;
    }
    if (normalizedQuery && !command.searchText.includes(normalizedQuery)) {
      continue;
    }
    seen.add(command.label);
    results.push(command);
  }

  return results;
}

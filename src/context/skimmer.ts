export function heuristicSkim(content: string, goalHint: string): string {
  const tokens = goalHint
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(Boolean);

  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const lower = line.toLowerCase();
    return tokens.some((token) => lower.includes(token)) || /import|throw|error|todo/i.test(line);
  });

  return kept.length > 0 ? kept.join("\n") : lines.slice(0, 80).join("\n");
}

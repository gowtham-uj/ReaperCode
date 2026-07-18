export interface BudgetedItem<T> {
  item: T;
  tokenCost: number;
  priority: number;
  rank?: number;
  stableKey: string;
}

export interface TruncationResult<T> {
  kept: BudgetedItem<T>[];
  dropped: BudgetedItem<T>[];
  usedTokens: number;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function applyDeterministicTruncation<T>(items: BudgetedItem<T>[], maxTokens: number): TruncationResult<T> {
  const ordered = [...items].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.stableKey.localeCompare(b.stableKey);
  });

  const kept: BudgetedItem<T>[] = [];
  const dropped: BudgetedItem<T>[] = [];
  let usedTokens = 0;

  for (const item of ordered) {
    if (usedTokens + item.tokenCost <= maxTokens) {
      kept.push(item);
      usedTokens += item.tokenCost;
    } else {
      dropped.push(item);
    }
  }

  return { kept, dropped, usedTokens };
}

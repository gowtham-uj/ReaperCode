export interface MentionResolution {
  fileMentions: string[];
  symbolMentions: string[];
}

const mentionPattern = /@([A-Za-z0-9_./\-]+)/g;

export function resolveMentions(prompt: string): MentionResolution {
  const fileMentions: string[] = [];
  const symbolMentions: string[] = [];

  for (const match of prompt.matchAll(mentionPattern)) {
    const value = match[1];
    if (!value) {
      continue;
    }

    if (value.includes("/") || value.includes(".")) {
      if (!fileMentions.includes(value)) {
        fileMentions.push(value);
      }
      continue;
    }

    if (!symbolMentions.includes(value)) {
      symbolMentions.push(value);
    }
  }

  return { fileMentions, symbolMentions };
}

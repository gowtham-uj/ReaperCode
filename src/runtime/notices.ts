export type NoticeSeverity = "debug" | "info" | "warn" | "error" | "fatal";

export interface Notice {
  id: string;
  timestamp: string;
  severity: NoticeSeverity;
  category: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface NoticeManagerConfig {
  minVerbosity: NoticeSeverity;
}

const SEVERITY_LEVELS: Record<NoticeSeverity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export class NoticeManager {
  private readonly notices: Notice[] = [];
  private readonly minLevel: number;

  constructor(config?: Partial<NoticeManagerConfig>) {
    this.minLevel = SEVERITY_LEVELS[config?.minVerbosity ?? "info"];
  }

  add(severity: NoticeSeverity, category: string, message: string, details?: Record<string, unknown>): void {
    if (SEVERITY_LEVELS[severity] < this.minLevel) {
      return;
    }

    this.notices.push({
      id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      severity,
      category,
      message,
      ...(details ? { details } : {}),
    });
  }

  getAll(): Notice[] {
    return [...this.notices];
  }

  getByCategory(category: string): Notice[] {
    return this.notices.filter((n) => n.category === category);
  }

  getBySeverity(minSeverity: NoticeSeverity): Notice[] {
    const level = SEVERITY_LEVELS[minSeverity];
    return this.notices.filter((n) => SEVERITY_LEVELS[n.severity] >= level);
  }

  clear(): void {
    this.notices.length = 0;
  }
}

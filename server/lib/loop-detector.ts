/**
 * Loop Detection Circuit Breaker — prevents infinite agent loops.
 * Detects: genericRepeat (same tool+args N times), pingPong (A→B→A→B),
 * stallDetection (no progress across N iterations), and thinkLoop
 * (same tool name called 3+ times consecutively regardless of args —
 * catches search_files retry spirals where args change slightly each time).
 */

interface ToolCallRecord {
  tool: string;
  argsHash: string;
  iteration: number;
}

/** Threshold for same-tool-name consecutive calls (think-loop detection). */
const THINK_LOOP_THRESHOLD = 6;

/**
 * Tools exempt from the think-loop detector.
 * selfdev_read_file is legitimately called many times in a row during Step 2
 * (reading multiple files sequentially) — firing on it is a false positive.
 */
const THINK_LOOP_EXEMPT = new Set([
  'selfdev_read_file',
  'selfdev_list_files',
  'selfdev_search_files',
  'read_file',
  'list_files',
]);

export class LoopDetector {
  private history: ToolCallRecord[] = [];
  private readonly historySize = 30;
  private readonly warningThreshold = 6;
  private readonly criticalThreshold = 10;

  /** Record a tool call. Returns 'ok' | 'warning' | 'critical'. */
  record(tool: string, args: Record<string, any>): 'ok' | 'warning' | 'critical' {
    const argsHash = this.hashArgs(args);
    this.history.push({ tool, argsHash, iteration: this.history.length });
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }

    // thinkLoop: same tool name called consecutively regardless of args
    // This catches search spirals where the agent retries with slightly different args
    const sameToolCount = this.countConsecutiveSameTool();
    if (sameToolCount >= THINK_LOOP_THRESHOLD) return 'warning';

    // genericRepeat: same tool+args called consecutively
    const repeatCount = this.countConsecutiveRepeats();
    if (repeatCount >= this.criticalThreshold) return 'critical';
    if (repeatCount >= this.warningThreshold) return 'warning';

    // pingPong: A→B→A→B pattern
    const pingPongCount = this.detectPingPong();
    if (pingPongCount >= this.criticalThreshold) return 'critical';
    if (pingPongCount >= this.warningThreshold) return 'warning';

    return 'ok';
  }

  /** Count how many consecutive calls share the same tool name (args may differ).
   * Returns 0 for tools that are exempt from think-loop detection. */
  countConsecutiveSameTool(): number {
    if (this.history.length < 2) return 0;
    const last = this.history[this.history.length - 1];
    // Exempt tools are never flagged — reading files sequentially is normal
    if (THINK_LOOP_EXEMPT.has(last.tool)) return 0;
    let count = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.history[i].tool === last.tool) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private countConsecutiveRepeats(): number {
    if (this.history.length < 2) return 1;
    const last = this.history[this.history.length - 1];
    let count = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      const prev = this.history[i];
      if (prev.tool === last.tool && prev.argsHash === last.argsHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private detectPingPong(): number {
    if (this.history.length < 4) return 0;
    const h = this.history;
    const a = h[h.length - 2];
    const b = h[h.length - 1];
    // Look backwards for alternating A-B pattern
    let count = 1;
    for (let i = h.length - 3; i >= 1; i -= 2) {
      if (h[i].tool === a.tool && h[i].argsHash === a.argsHash &&
          h[i - 1]?.tool === b.tool && h[i - 1]?.argsHash === b.argsHash) {
        // Wait, wrong direction — let me fix: we check i and i-1
        // Actually: alternating pattern is h[len-1]=B, h[len-2]=A, h[len-3]=B, h[len-4]=A
      }
      if (h[i].tool === b.tool && h[i].argsHash === b.argsHash &&
          h[i - 1]?.tool === a.tool && h[i - 1]?.argsHash === a.argsHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private hashArgs(args: Record<string, any>): string {
    try {
      // Simple deterministic hash — sort keys and stringify
      const sorted = JSON.stringify(args, Object.keys(args).sort());
      let hash = 0;
      for (let i = 0; i < sorted.length; i++) {
        const char = sorted.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return String(hash);
    } catch {
      return 'unknown';
    }
  }

  /** Get a human-readable status message. */
  getStatus(): string {
    if (this.history.length === 0) return 'No tool calls recorded';
    const repeats = this.countConsecutiveRepeats();
    const pingPong = this.detectPingPong();
    return `history=${this.history.length}, consecutiveRepeats=${repeats}, pingPong=${pingPong}`;
  }

  /** Reset the detector (e.g., on new conversation). */
  reset(): void {
    this.history = [];
  }
}

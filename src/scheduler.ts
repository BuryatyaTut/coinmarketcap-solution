import { AppError, errorCode } from './errors';
import { Logger } from './types';

export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller?: AbortController;
  private started = false;
  private stopping = false;

  constructor(
    private readonly work: (signal: AbortSignal) => Promise<void>,
    private readonly intervalMs: number,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.launch();
  }

  private launch(): void {
    if (this.stopping) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.active = (async () => {
      let nextDelay = this.intervalMs;
      try {
        await this.work(signal);
      } catch (error) {
        if (!this.stopping) {
          this.log('sync_failed', { code: errorCode(error) });
        }
        if (error instanceof AppError) {
          nextDelay = Math.max(nextDelay, error.retryAfterMs);
        }
      } finally {
        if (!this.stopping) {
          this.timer = setTimeout(() => this.launch(), nextDelay);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
}

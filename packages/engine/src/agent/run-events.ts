import { EventEmitter } from 'node:events';
import type { AgentEvent } from './events.js';

export interface SequencedAgentEvent {
  readonly seq: number;
  readonly at: number;
  readonly event: AgentEvent;
}

export class RunEventBus extends EventEmitter {
  private _seq = 0;
  private _commitChain: Promise<void> = Promise.resolve();

  get seq(): number {
    return this._seq;
  }

  publish(event: AgentEvent): SequencedAgentEvent {
    const record: SequencedAgentEvent = {
      seq: ++this._seq,
      at: Date.now(),
      event,
    };
    this.emit('event', record);
    this.emit(event.type, record);
    return record;
  }

  enqueueCommit(fn: () => void | Promise<void>): Promise<void> {
    const run = async () => {
      await fn();
    };
    const next = this._commitChain.then(run, run);
    this._commitChain = next.catch(() => {});
    return next;
  }

  flush(): Promise<void> {
    return this._commitChain;
  }
}

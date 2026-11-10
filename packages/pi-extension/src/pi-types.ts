import type { ContextWithSystemEvent } from '@earendil-works/pi-coding-agent';

/** pi agent transcript message (derived from the public event type). */
export type AgentMessage = ContextWithSystemEvent['messages'][number];

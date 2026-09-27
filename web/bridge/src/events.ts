import type { EventsMessage } from "@workbench/shared";

/**
 * Events the bridge raises itself, as opposed to herdr's: a clone's progress,
 * and whatever later surfaces need to push to every open tab. `/ws/events`
 * forwards them next to herdr's own.
 */
export class BridgeEvents {
  private readonly listeners = new Set<(m: EventsMessage) => void>();

  on(listener: (m: EventsMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(m: EventsMessage): void {
    for (const listener of this.listeners) listener(m);
  }
}

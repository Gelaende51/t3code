import { create } from "zustand";

/** One request to bring a message of the shown thread into view. */
export interface ThreadRevealState {
  readonly threadKey: string | null;
  readonly messageId: string | null;
  /** Text from the target message, used to place the flash on the right heading. */
  readonly query: string;
  readonly requestId: number;
}

const CLOSED_THREAD_REVEAL: ThreadRevealState = {
  threadKey: null,
  messageId: null,
  query: "",
  requestId: 0,
};

export const useThreadRevealStore = create<ThreadRevealState>(() => CLOSED_THREAD_REVEAL);

/** Requests a one-shot reveal; the timeline clears its flash once it has played. */
export function revealThreadMessage(threadKey: string, messageId: string, query: string): void {
  useThreadRevealStore.setState((previous) => ({
    threadKey,
    messageId,
    query,
    requestId: previous.requestId + 1,
  }));
}

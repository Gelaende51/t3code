import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { CHAT_TIMELINE_ANCHOR_OFFSET } from "./timelineScrollAnchoring";
import { useThreadRevealStore } from "./threadRevealStore";

const REVEAL_VIEW_MARGIN = 96;
const REVEAL_FLASH_MS = 1_100;

interface RevealHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

const flashRect = (rect: Pick<DOMRect, "top" | "left" | "width" | "height">) => {
  const element = document.createElement("div");
  element.className = "thread-reveal-flash";
  element.style.position = "fixed";
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${Math.max(rect.width, 8)}px`;
  element.style.height = `${Math.max(rect.height, 8)}px`;
  document.body.append(element);
  const remove = () => {
    element.remove();
  };
  element.addEventListener("animationend", remove, { once: true });
  window.setTimeout(remove, REVEAL_FLASH_MS);
  return element;
};

const textRange = (row: HTMLElement, query: string): Range | null => {
  const phrase = query.trim().toLocaleLowerCase();
  if (phrase.length === 0) return null;
  const needles = [
    phrase,
    ...phrase
      .split(/\s+/)
      .filter((word) => word.length >= 4)
      .sort((left, right) => right.length - left.length),
  ].filter((needle, index, all) => all.indexOf(needle) === index);

  const nodes: Text[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent && node.textContent.trim().length > 0) nodes.push(node as Text);
  }
  for (const needle of needles) {
    for (const node of nodes) {
      const text = node.textContent ?? "";
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      return range;
    }
  }
  return null;
};

const escapeAttribute = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/**
 * Brings a message requested by a plugin view into view and flashes its target
 * heading once. The flash is an overlay that removes itself; the timeline's
 * text and the persistent find highlights are untouched.
 */
export function useThreadRevealNavigation({
  threadKey,
  container,
  rows,
  listRef,
  listReady,
  navigate,
  historyControls,
}: {
  readonly threadKey: string;
  readonly container: HTMLElement | null;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly listReady: boolean;
  readonly navigate: () => void;
  readonly historyControls: RevealHistoryControls | undefined;
}) {
  const request = useThreadRevealStore();
  const handled = useRef(0);
  const requestedEarlier = useRef<string | null>(null);
  const flash = useRef<HTMLElement | null>(null);
  const generation = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the one-shot DOM flash overlay for this mount and removes it on unmount.
  useEffect(() => {
    if (flash.current !== null) flash.current.remove();
    flash.current = null;
    generation.current += 1;
    return () => {
      generation.current += 1;
      flash.current?.remove();
      flash.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls and flashes the timeline DOM in response to a store request, without changing React state.
  useEffect(() => {
    if (
      !listReady ||
      container === null ||
      request.threadKey !== threadKey ||
      request.messageId === null ||
      request.requestId <= handled.current
    )
      return;

    const messageId = request.messageId;
    const rowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === messageId,
    );
    if (rowIndex < 0) {
      if (
        historyControls?.hasMoreHistory &&
        !historyControls.loading &&
        historyControls.error === null &&
        requestedEarlier.current !== messageId
      ) {
        requestedEarlier.current = messageId;
        historyControls.onLoadEarlier(messageId);
      }
      return;
    }

    handled.current = request.requestId;
    requestedEarlier.current = null;
    flash.current?.remove();
    flash.current = null;
    navigate();

    const requestGeneration = ++generation.current;
    const list = listRef.current;
    if (list === null) return;
    void list
      .scrollToIndex({
        index: rowIndex,
        animated: false,
        viewPosition: 0,
        viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      })
      .then(() => {
        requestAnimationFrame(() => {
          if (generation.current !== requestGeneration) return;
          const row = container.querySelector<HTMLElement>(
            `[data-timeline-row-kind="message"][data-message-id="${escapeAttribute(messageId)}"]`,
          );
          if (row === null) return;
          const range = textRange(row, request.query);
          if (range === null) {
            const rect = row.getBoundingClientRect();
            flash.current = flashRect({
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: Math.min(rect.height, 72),
            });
            return;
          }

          const rect = range.getBoundingClientRect();
          const viewport = container.getBoundingClientRect();
          const margin = Math.min(
            REVEAL_VIEW_MARGIN,
            Math.max(0, (viewport.height - rect.height) / 2),
          );
          const top = viewport.top + margin;
          const bottom = viewport.bottom - margin;
          const delta =
            rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
          if (Math.abs(delta) >= 1) container.scrollTop += delta;
          flash.current = flashRect(range.getBoundingClientRect());
        });
      });
  }, [container, historyControls, listReady, listRef, navigate, request, rows, threadKey]);
}

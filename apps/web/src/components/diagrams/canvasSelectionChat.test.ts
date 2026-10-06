import { describe, expect, it } from "vite-plus/test";

import {
  addCanvasSelectionToChat,
  canvasSelectionChatState,
  registerCanvasSelectionChat,
} from "./canvasSelectionChat";

describe("canvas selection chat action", () => {
  it("adds only while the registered editor has a selection", () => {
    const added: string[] = [];
    const panel = registerCanvasSelectionChat(() => added.push("panel"));
    expect(canvasSelectionChatState()).toBe("empty");
    expect(addCanvasSelectionToChat()).toBe(false);
    panel.setHasSelection(true);
    expect(canvasSelectionChatState()).toBe("selected");
    expect(addCanvasSelectionToChat()).toBe(true);
    expect(added).toEqual(["panel"]);
    panel.unregister();
    expect(canvasSelectionChatState()).toBe("unavailable");
    expect(addCanvasSelectionToChat()).toBe(false);
  });

  it("keeps a remounted editor when the previous one unregisters late", () => {
    const added: string[] = [];
    const previous = registerCanvasSelectionChat(() => added.push("previous"));
    const next = registerCanvasSelectionChat(() => added.push("next"));
    previous.setHasSelection(true);
    previous.unregister();
    expect(canvasSelectionChatState()).toBe("empty");
    next.setHasSelection(true);
    addCanvasSelectionToChat();
    expect(added).toEqual(["next"]);
    next.unregister();
  });
});

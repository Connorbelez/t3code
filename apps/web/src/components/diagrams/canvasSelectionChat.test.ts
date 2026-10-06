import { describe, expect, it } from "vite-plus/test";

import {
  addCanvasSelectionToChat,
  annotateCanvasSelection,
  canvasAnnotationState,
  canvasSelectionChatState,
  registerCanvasSelectionChat,
  toggleCanvasAnnotationMode,
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

  it("annotates only while an editor that can save comments has a selection", () => {
    const calls: string[] = [];
    expect(annotateCanvasSelection()).toBe(false);
    expect(toggleCanvasAnnotationMode()).toBe(false);
    const plain = registerCanvasSelectionChat(() => calls.push("add"));
    plain.setHasSelection(true);
    expect(canvasAnnotationState()).toBe("unavailable");
    expect(annotateCanvasSelection()).toBe(false);
    const panel = registerCanvasSelectionChat(() => calls.push("add"), {
      annotate: () => calls.push("annotate"),
      toggle: () => calls.push("toggle"),
    });
    expect(canvasAnnotationState()).toBe("off");
    expect(annotateCanvasSelection()).toBe(false);
    expect(toggleCanvasAnnotationMode()).toBe(true);
    panel.setAnnotating(true);
    expect(canvasAnnotationState()).toBe("on");
    panel.setHasSelection(true);
    expect(annotateCanvasSelection()).toBe(true);
    expect(addCanvasSelectionToChat()).toBe(true);
    expect(calls).toEqual(["toggle", "annotate", "add"]);
    panel.unregister();
    plain.unregister();
    expect(canvasAnnotationState()).toBe("unavailable");
  });
});

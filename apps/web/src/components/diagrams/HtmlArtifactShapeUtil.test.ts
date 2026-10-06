// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DiagramSaveState } from "./diagramSocket";
import {
  artifactDocument,
  artifactStyleSession,
  subscribeWhenDiagramSaved,
} from "./HtmlArtifactShapeUtil";

vi.hoisted(() =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }),
);

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
  vi.restoreAllMocks();
});

function mountArtifact(html: string, css = "", baseUrl?: string) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const child = frame.contentWindow;
  const artifact = frame.contentDocument;
  if (!child || !artifact) throw new Error("Artifact iframe was not created.");
  artifact.open();
  artifact.write(artifactDocument(html, css, baseUrl));
  artifact.close();
  const script = artifact.body.lastElementChild;
  if (script?.tagName !== "SCRIPT") throw new Error("Artifact bridge was not injected.");
  const send = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  Function(
    "window",
    "document",
    "parent",
    "MutationObserver",
    "queueMicrotask",
    script.textContent,
  )(child, artifact, window, MutationObserver, queueMicrotask);
  return { child, document: artifact, send };
}

describe("HTML artifact document bridge", () => {
  it("renews signed resource credentials without replacing the live document", () => {
    const { child, document } = mountArtifact(
      '<input value="initial"><img src="image.png">',
      "",
      "https://environment.test/api/assets/old/page.html",
    );
    const input = document.querySelector("input");
    if (!input) throw new Error("Artifact input was not created.");
    input.value = "edited";
    child.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: {
          type: "t3-artifact-base",
          url: "https://environment.test/api/assets/renewed/page.html",
        },
      }),
    );
    expect(document.querySelector("img")?.src).toBe(
      "https://environment.test/api/assets/renewed/image.png",
    );
    expect(document.querySelector("input")).toBe(input);
    expect(input.value).toBe("edited");
  });

  it("keeps edits through a failed styling request and applies pending classes after reconnect", async () => {
    const { child, document } = mountArtifact('<input value="initial">');
    const input = document.querySelector("input");
    if (!input) throw new Error("Artifact input was not created.");
    input.value = "edited";
    let connected = false;
    let reconnect = () => {};
    let resolveApplied = () => {};
    const applied = new Promise<void>((resolve) => {
      resolveApplied = resolve;
    });
    const session = artifactStyleSession({
      html: '<input value="initial">',
      css: async ({ candidates }) => {
        if (!connected) throw new Error("Environment is not connected.");
        expect(candidates).toEqual(["bg-emerald-500"]);
        return { css: ".bg-emerald-500{background:green}" };
      },
      whenReady: (ready) => {
        reconnect = ready;
        return () => {};
      },
      apply: (css) => {
        child.dispatchEvent(
          new MessageEvent("message", { source: window, data: { type: "t3-artifact-css", css } }),
        );
        resolveApplied();
      },
    });
    try {
      await session.add(["bg-emerald-500"]);
      expect(document.getElementById("t3-artifact-tailwind")?.textContent).toBe("");
      expect(input.value).toBe("edited");
      connected = true;
      reconnect();
      await applied;
      expect(document.getElementById("t3-artifact-tailwind")?.textContent).toBe(
        ".bg-emerald-500{background:green}",
      );
      expect(document.querySelector("input")).toBe(input);
      expect(input.value).toBe("edited");
    } finally {
      session.dispose();
    }
  });

  it("replays initial classes when the parent requests them after load", () => {
    const { child, send } = mountArtifact('<button class="bg-indigo-500 rounded-lg">Go</button>');
    expect(send).toHaveBeenLastCalledWith(
      { type: "t3-artifact-classes", candidates: ["bg-indigo-500", "rounded-lg"] },
      "*",
    );
    send.mockClear();
    child.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "t3-artifact-classes-request" },
      }),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: "t3-artifact-classes", candidates: ["bg-indigo-500", "rounded-lg"] },
      "*",
    );
  });

  it("reports classes added by scripts and applies compiled CSS without rebuilding the document", async () => {
    const { child, document, send } = mountArtifact('<input value="kept" />', "input{color:red}");
    const input = document.querySelector("input");
    if (!input) throw new Error("Artifact input was not created.");
    input.value = "edited";
    send.mockClear();
    const button = document.createElement("button");
    button.className = "px-4 bg-violet-500";
    document.body.append(button);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: "t3-artifact-classes", candidates: ["px-4", "bg-violet-500"] },
      "*",
    );
    child.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { type: "t3-artifact-css", css: ".px-4{padding-inline:1rem}" },
      }),
    );
    expect(document.getElementById("t3-artifact-tailwind")?.textContent).toBe(
      ".px-4{padding-inline:1rem}",
    );
    expect(input.value).toBe("edited");
    expect(document.querySelector("button")).toBe(button);
  });

  it("bounds candidate accumulation and ignores messages from another window", () => {
    const valid = Array.from({ length: 5001 }, (_, index) => `class-${index}`);
    const { child, document, send } = mountArtifact(
      `<div class="${"x".repeat(501)} ${valid.join(" ")}"></div>`,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: "t3-artifact-classes", candidates: valid.slice(0, 5000) },
      "*",
    );
    child.dispatchEvent(
      new MessageEvent("message", {
        source: child,
        data: { type: "t3-artifact-css", css: "untrusted" },
      }),
    );
    expect(document.getElementById("t3-artifact-tailwind")?.textContent).toBe("");
  });
});

describe("saved artifact source subscription", () => {
  it("retries when reconnect happens before the disconnected request rejects", async () => {
    let rejectDisconnected = (_reason: Error) => {};
    const disconnected = new Promise<{ css: string }>((_resolve, reject) => {
      rejectDisconnected = reject;
    });
    let resolveApplied = (_css: string) => {};
    const applied = new Promise<string>((resolve) => {
      resolveApplied = resolve;
    });
    let reconnect = () => {};
    let attempts = 0;
    const session = artifactStyleSession({
      html: "<div></div>",
      css: async () => {
        attempts += 1;
        return attempts === 1 ? disconnected : { css: ".p-4{padding:1rem}" };
      },
      apply: resolveApplied,
      whenReady: (ready) => {
        reconnect = ready;
        return () => {};
      },
    });
    try {
      const initial = session.add(["p-4"]);
      reconnect();
      rejectDisconnected(new Error("Previous connection closed."));
      await initial;
      expect(await applied).toBe(".p-4{padding:1rem}");
      expect(attempts).toBe(2);
    } finally {
      session.dispose();
    }
  });

  it("starts an offline artifact after reconnect and recreates its watch after another disconnect", () => {
    let state: DiagramSaveState = "offline";
    const listeners = new Set<() => void>();
    const stopped = vi.fn();
    const watch = vi.fn(() => stopped);
    const dispose = subscribeWhenDiagramSaved(
      {
        getSaveState: () => state,
        subscribeSave: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      watch,
    );
    const changeState = (next: DiagramSaveState) => {
      state = next;
      for (const listener of listeners) listener();
    };
    expect(watch).not.toHaveBeenCalled();
    changeState("connecting");
    changeState("pending");
    expect(watch).not.toHaveBeenCalled();
    changeState("saved");
    expect(watch).toHaveBeenCalledTimes(1);
    changeState("pending");
    changeState("saved");
    expect(watch).toHaveBeenCalledTimes(1);
    changeState("offline");
    expect(stopped).toHaveBeenCalledTimes(1);
    changeState("saved");
    expect(watch).toHaveBeenCalledTimes(2);
    dispose();
    expect(stopped).toHaveBeenCalledTimes(2);
    changeState("saved");
    expect(watch).toHaveBeenCalledTimes(2);
  });
});

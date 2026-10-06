import { defineKit } from "../kit.ts";
import { screen } from "../screens.ts";
import { decision } from "./flow.ts";

export const userFlow = defineKit({
  name: "user-flow",
  guidance:
    "User flows: screens connected by the actions that move between them, laid out left to right. " +
    "Nodes are screens, the default kind, and decisions. A screen without a body is an empty labelled frame " +
    "for a rough draft; give it a wireframe body (see the wireframe kit) to sketch its contents. " +
    'Write edges as [from, to, trigger], e.g. ["login.submit", "home", "tap Log in"]: an end may be ' +
    "screen.element to bind the arrow to that element, and is otherwise a screen or decision key. " +
    'Label a decision\'s edges with its answers, e.g. "yes" and "no". ' +
    "A patch lists each screen it changes with that screen's whole body; edges from elements it no longer has drop. " +
    "Add notes with kind note.",
  look: "sketch",
  direction: "right",
  arrowKind: "arc",
  // Room between screens for the trigger labels.
  layerGap: 240,
  nodeKinds: { screen, decision },
  defaultKind: "screen",
  edgeKinds: {
    navigate: {
      description:
        'The user moves on; label it with the trigger, e.g. "tap Sign up". The default edge kind.',
      color: "black",
      arrowheadStart: "none",
      arrowheadEnd: "arrow",
    },
  },
  defaultEdgeKind: "navigate",
  example: {
    kit: "user-flow",
    key: "onboarding",
    title: "Onboarding",
    nodes: [
      {
        key: "welcome",
        label: "Welcome",
        body: {
          children: [
            { key: "title", kind: "heading", label: "Plan trips together" },
            { key: "start", kind: "button", label: "Get started" },
          ],
        },
      },
      { key: "hasAccount", kind: "decision", label: "Has account?" },
      { key: "login", label: "Log in" },
      { key: "signup", label: "Sign up" },
    ],
    edges: [
      ["welcome.start", "hasAccount", "tap Get started"],
      ["hasAccount", "login", "yes"],
      ["hasAccount", "signup", "no"],
    ],
  },
});

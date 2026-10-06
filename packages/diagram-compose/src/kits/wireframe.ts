import { defineKit } from "../kit.ts";
import { screen } from "../screens.ts";

export const wireframe = defineKit({
  name: "wireframe",
  guidance:
    "Low-fidelity screens drawn as sketches. Each node is a screen, the default kind, laid out side by side in spec order. " +
    "A screen's body sets device (phone, tablet or web; phone by default), landscape, chrome (a status bar, or a browser bar on web) " +
    "and modal (a dialog over a dimmed screen), and lists its elements top to bottom in children. " +
    "An element is { key, kind, label?, size? }; keys are unique within a screen and read back as screen.element. " +
    'Group elements in an invisible { kind: "stack" } or { kind: "row" }, or a visible { key, kind: "card" }, each with ' +
    "children and optional gap, padding and align; the screen body takes gap, padding and align too. " +
    'size is pixels or "fill" along the container\'s direction; fill shares the space left over, so a fill stack between ' +
    "a navBar and a tabBar pushes the tabBar to the bottom. align is start, center, end or stretch across it; stacks stretch " +
    "and rows center by default. Inserting an element pushes the ones after it along. " +
    "A patch lists each screen it changes with that screen's whole body, and leaves other screens alone. " +
    "Wireframes have no edges. Add notes with kind note.",
  look: "sketch",
  direction: "down",
  arrowKind: "arc",
  nodeKinds: { screen },
  defaultKind: "screen",
  edgeKinds: {},
  defaultEdgeKind: null,
  example: {
    kit: "wireframe",
    key: "auth",
    title: "Sign in",
    nodes: [
      {
        key: "login",
        label: "Log in",
        body: {
          chrome: true,
          children: [
            { key: "title", kind: "heading", label: "Welcome back" },
            { key: "email", kind: "input", label: "Email" },
            { key: "password", kind: "input", label: "Password" },
            {
              kind: "row",
              children: [
                { key: "remember", kind: "text", label: "Remember me", size: "fill" },
                { key: "rememberToggle", kind: "toggle" },
              ],
            },
            { key: "submit", kind: "button", label: "Log in" },
          ],
        },
      },
      {
        key: "reset",
        label: "Reset password",
        body: {
          modal: true,
          children: [
            { key: "prompt", kind: "text", label: "We'll email you a link." },
            { key: "send", kind: "button", label: "Send link" },
          ],
        },
      },
    ],
  },
});

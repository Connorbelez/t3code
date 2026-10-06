import { DiagramMemberKey } from "@t3tools/contracts";
import type { TLDefaultSizeStyle } from "@tldraw/tlschema";
import * as Schema from "effect/Schema";

import { hashOf, isContent, type StoredNode } from "./identity.ts";
import {
  type GeoKind,
  type LineKind,
  rowOf,
  type ScreenKind,
  type Size,
  type TextKind,
} from "./kit.ts";
import type { MeasureText, TextFont } from "./layout.ts";
import type { SpecIssue } from "./spec.ts";
import {
  ALIGNS,
  type Align,
  arrangeStack,
  type Box,
  naturalSize,
  type StackContainer,
  type StackItem,
} from "./stack.ts";

/**
 * Screens: device frames whose body lowers into one member per element, so a human edit to one
 * button never conflicts with an agent change to another. Containers are layout, not members: a
 * screen's contents always relay out from the spec, so the canvas only keeps a hash of the
 * arrangement (containers, sizes and element order) to tell when to do that. Kits with screens
 * share this module.
 */

type Device = "phone" | "tablet" | "web";
const DEVICES: Readonly<Record<Device, Size>> = {
  phone: { w: 393, h: 852 },
  tablet: { w: 834, h: 1194 },
  web: { w: 1440, h: 900 },
};
const DEVICE_NAMES = ["phone", "tablet", "web"] as const;

const Spacing = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 400 }));

/** The screen member's own body once its elements are members of their own. */
const ScreenSettings = Schema.Struct({
  device: Schema.Literals(DEVICE_NAMES),
  landscape: Schema.Boolean,
  chrome: Schema.Boolean,
  modal: Schema.Boolean,
});
type ScreenSettings = typeof ScreenSettings.Type;
const isScreenSettings = Schema.is(ScreenSettings);

type ElementKind = GeoKind | TextKind | LineKind;

const ELEMENTS = {
  navBar: {
    shape: "geo",
    description: "a top bar titled by its label",
    geo: "rectangle",
    color: "grey",
    fill: "solid",
    size: "s",
    minSize: { w: 96, h: 56 },
  },
  tabBar: {
    shape: "geo",
    description: 'a bottom bar; label it with the tabs, e.g. "Home · Search · Profile"',
    geo: "rectangle",
    color: "grey",
    fill: "solid",
    size: "s",
    minSize: { w: 96, h: 56 },
  },
  button: {
    shape: "geo",
    description: "a button",
    geo: "rectangle",
    color: "black",
    fill: "solid",
    size: "s",
    minSize: { w: 96, h: 48 },
  },
  input: {
    shape: "geo",
    description: "a text field whose label is its placeholder",
    geo: "rectangle",
    color: "grey",
    fill: "semi",
    size: "s",
    align: "start",
    labelColor: "grey",
    minSize: { w: 200, h: 48 },
  },
  text: { shape: "text", description: "body text", size: "s", color: "black" },
  heading: { shape: "text", description: "a heading", size: "m", color: "black" },
  image: {
    shape: "geo",
    description: "an image placeholder captioned by its label",
    geo: "x-box",
    color: "grey",
    fill: "none",
    size: "s",
    minSize: { w: 120, h: 160 },
  },
  card: {
    shape: "geo",
    description: "a visible box that stacks its children like a stack",
    geo: "rectangle",
    color: "grey",
    fill: "none",
    hideLabel: true,
    minSize: { w: 0, h: 0 },
  },
  listItem: {
    shape: "geo",
    description: "a row in a list",
    geo: "rectangle",
    color: "grey",
    fill: "none",
    size: "s",
    align: "start",
    minSize: { w: 120, h: 56 },
  },
  toggle: {
    shape: "geo",
    description: "a switch, without a label",
    geo: "oval",
    color: "black",
    fill: "solid",
    hideLabel: true,
    minSize: { w: 52, h: 32 },
  },
  avatar: {
    shape: "geo",
    description: "a round picture, without a label",
    geo: "ellipse",
    color: "grey",
    fill: "solid",
    hideLabel: true,
    minSize: { w: 48, h: 48 },
  },
  divider: { shape: "line", description: "a horizontal rule", color: "grey" },
} satisfies Record<string, ElementKind>;
type ElementName = keyof typeof ELEMENTS;
const ELEMENT_NAMES = Object.keys(ELEMENTS) as ElementName[];
const isElementName = (kind: string): kind is ElementName => Object.hasOwn(ELEMENTS, kind);
const RIGID: ReadonlySet<string> = new Set<ElementName>(["toggle", "avatar"]);

/** Parts of the screen itself, drawn as members keyed by these reserved element keys. */
const FIXTURES = {
  statusBar: {
    shape: "geo",
    description: "the phone or tablet status bar",
    geo: "rectangle",
    color: "black",
    fill: "none",
    dash: "none",
    size: "s",
    align: "start",
    minSize: { w: 0, h: 44 },
  },
  browserBar: {
    shape: "geo",
    description: "the web browser bar",
    geo: "rectangle",
    color: "grey",
    fill: "solid",
    dash: "none",
    hideLabel: true,
    minSize: { w: 0, h: 44 },
  },
  backdrop: {
    shape: "geo",
    description: "the dimmed screen behind a modal",
    geo: "rectangle",
    color: "grey",
    fill: "solid",
    dash: "none",
    hideLabel: true,
    minSize: { w: 0, h: 0 },
  },
  sheet: {
    shape: "geo",
    description: "the box a modal's contents sit in",
    geo: "rectangle",
    color: "black",
    fill: "semi",
    hideLabel: true,
    minSize: { w: 0, h: 0 },
  },
} satisfies Record<string, GeoKind>;
const CHROME = "chrome";
const BACKDROP = "backdrop";
const SHEET = "sheet";
const RESERVED = [CHROME, BACKDROP, SHEET];

/** An element the spec wrote, which edges can start or end at; the screen's own parts are not. */
export function isElement(member: StoredNode): boolean {
  return isContent(member) && isElementName(member.kind);
}

/** Every kind a screen's members can have. */
const CONTENT_KINDS: Readonly<Record<string, ElementKind>> = { ...ELEMENTS, ...FIXTURES };

export function contentKindOf(kind: string): ElementKind | undefined {
  return rowOf(CONTENT_KINDS, kind);
}

const CONTAINERS = ["stack", "row"] as const;
type ContainerKind = (typeof CONTAINERS)[number] | "card" | "screen";
const SPACING: Record<ContainerKind, { gap: number; padding: number; align: Align }> = {
  screen: { gap: 16, padding: 24, align: "stretch" },
  stack: { gap: 12, padding: 0, align: "stretch" },
  card: { gap: 12, padding: 16, align: "stretch" },
  row: { gap: 12, padding: 0, align: "center" },
};

/** Any element or container. Which fields a kind takes is checked while lowering. */
interface ElementInput {
  readonly key?: string | undefined;
  readonly kind: ElementName | (typeof CONTAINERS)[number];
  readonly label?: string | undefined;
  readonly size?: "fill" | number | undefined;
  readonly gap?: number | undefined;
  readonly padding?: number | undefined;
  readonly align?: Align | undefined;
  readonly children?: readonly ElementInput[] | undefined;
}
const Element: Schema.Codec<ElementInput> = Schema.Struct({
  key: Schema.optional(DiagramMemberKey),
  kind: Schema.Literals([...ELEMENT_NAMES, ...CONTAINERS]),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  size: Schema.optional(
    Schema.Union([
      Schema.Literal("fill"),
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 4000 })),
    ]),
  ),
  gap: Schema.optional(Spacing),
  padding: Schema.optional(Spacing),
  align: Schema.optional(Schema.Literals(ALIGNS)),
  children: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Codec<ElementInput> => Element)),
  ),
});
const CONTAINER_FIELDS = ["kind", "size", "gap", "padding", "align", "children"];

const ScreenBody = Schema.Struct({
  device: Schema.optional(Schema.Literals(DEVICE_NAMES)),
  landscape: Schema.optional(Schema.Boolean),
  chrome: Schema.optional(Schema.Boolean),
  modal: Schema.optional(Schema.Boolean),
  gap: Schema.optional(Spacing),
  padding: Schema.optional(Spacing),
  align: Schema.optional(Schema.Literals(ALIGNS)),
  children: Schema.optional(Schema.Array(Element)),
});
const decodeScreenBody = Schema.decodeUnknownSync(ScreenBody);

export const screen: ScreenKind = {
  shape: "screen",
  description:
    "A device frame titled by its label. Its body lays out elements top to bottom: " +
    "{ device: phone | tablet | web, landscape, chrome, modal, gap, padding, align, children }. " +
    `Elements are { key, kind, label?, size? }: ${ELEMENT_NAMES.filter((name) => name !== "card")
      .map((name) => `${name} (${ELEMENTS[name].description})`)
      .join(", ")}.`,
  body: ScreenBody,
};

export interface ScreenContents {
  /** Screen parts (chrome, modal backdrop and sheet), then elements depth first. */
  readonly members: readonly StoredNode[];
  readonly root: StackContainer;
  /** Hash of the containers, sizes and element order; when it changes the screen relays out. */
  readonly arrangement: string;
}

/**
 * Splits a validated screen body into the screen's own settings and its contents, one member per
 * element keyed `screen.element`. Adds an issue, naming the valid options, for each bad element.
 */
export function lowerScreen(
  key: string,
  body: Schema.JsonObject,
  path: string,
  issues: SpecIssue[],
): { body: Schema.JsonObject; contents: ScreenContents } {
  const input = decodeScreenBody(body);
  const settings: ScreenSettings = {
    device: input.device ?? "phone",
    landscape: input.landscape ?? false,
    chrome: input.chrome ?? false,
    modal: input.modal ?? false,
  };
  const members: StoredNode[] = [];
  const member = (name: string, kind: string, label: string) => {
    members.push({
      role: "node",
      key: `${key}.${name}`,
      kind,
      label,
      parent: key,
      ref: null,
      body: null,
    });
  };
  if (settings.chrome) {
    if (settings.device === "web") member(CHROME, "browserBar", "");
    else member(CHROME, "statusBar", "9:41");
  }
  if (settings.modal) {
    member(BACKDROP, "backdrop", "");
    member(SHEET, "sheet", "");
  }

  const seen = new Set<string>();
  const issue = (at: string, message: string) => issues.push({ path: at, message });
  const walk = (items: readonly ElementInput[], at: string): StackItem[] =>
    items.flatMap((item, i): StackItem[] => {
      const here = `${at}[${i}]`;
      const { kind } = item;
      const element = isElementName(kind) ? ELEMENTS[kind] : null;
      const holds = element === null || kind === "card";
      const labelled = element !== null && !("hideLabel" in element) && element.shape !== "line";
      const valid = [
        ...(element ? ["key"] : []),
        ...(holds ? CONTAINER_FIELDS : ["kind", "size"]),
        ...(labelled ? ["label"] : []),
      ];
      for (const field of Object.keys(item)) {
        if (!valid.includes(field)) {
          issue(
            `${here}.${field}`,
            `${kind} takes no field "${field}"; valid fields: ${valid.join(", ")}`,
          );
        }
      }

      let memberKey: string | null = null;
      const name = item.key;
      if (element && name === undefined) {
        issue(`${here}.key`, `${kind} needs a key, unique within the screen`);
      } else if (element && name !== undefined) {
        if (RESERVED.includes(name)) {
          issue(
            `${here}.key`,
            `"${name}" is reserved for the screen's own parts (${RESERVED.join(", ")})`,
          );
        } else if (seen.has(name)) {
          issue(`${here}.key`, `duplicate element key "${name}" in screen "${key}"`);
        } else {
          seen.add(name);
          memberKey = `${key}.${name}`;
          member(name, kind, item.label ?? (labelled ? name : ""));
        }
      }
      const size = item.size ?? null;
      if (!holds) return memberKey === null ? [] : [{ member: memberKey, size }];
      const defaults = SPACING[isElementName(kind) ? "card" : kind];
      return [
        {
          axis: kind === "row" ? "row" : "column",
          member: memberKey,
          size,
          gap: item.gap ?? defaults.gap,
          padding: item.padding ?? defaults.padding,
          align: item.align ?? defaults.align,
          children: walk(item.children ?? [], `${here}.children`),
        },
      ];
    });

  const root: StackContainer = {
    axis: "column",
    member: settings.modal ? `${key}.${SHEET}` : null,
    gap: input.gap ?? SPACING.screen.gap,
    padding: input.padding ?? SPACING.screen.padding,
    align: input.align ?? SPACING.screen.align,
    size: null,
    children: walk(input.children ?? [], `${path}.children`),
  };
  return { body: settings, contents: { members, root, arrangement: hashOf(root) } };
}

function settingsOf(screen: StoredNode): ScreenSettings {
  return isScreenSettings(screen.body)
    ? screen.body
    : { device: "phone", landscape: false, chrome: false, modal: false };
}

export function screenSize(screen: StoredNode): Size {
  const { device, landscape } = settingsOf(screen);
  const size = DEVICES[device];
  return landscape ? { w: size.h, h: size.w } : size;
}

/** tldraw's geo label and text shape font sizes, from a base of 16. */
const LABEL_FONT_SIZES: Record<TLDefaultSizeStyle, number> = { s: 18, m: 22, l: 26, xl: 32 };
const TEXT_FONT_SIZES: Record<TLDefaultSizeStyle, number> = { s: 18, m: 24, l: 36, xl: 44 };
const LABEL_PADDING = 16;
const MODAL_MARGIN = 24;
const MODAL_MAX_WIDTH = 480;

/** Up to a multiple of 4, so sub-pixel font differences between hosts rarely change a size. */
function snap(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function leafSize(
  kind: ElementKind,
  text: string,
  maxWidth: number,
  family: TextFont["family"],
  measure: MeasureText,
): Size {
  switch (kind.shape) {
    case "geo": {
      const label = kind.hideLabel ? "" : text;
      const measured =
        label.trim() === ""
          ? { w: 0, h: 0 }
          : measure(label, {
              family,
              fontSize: LABEL_FONT_SIZES[kind.size ?? "m"],
              maxWidth: Math.max(1, maxWidth - 2 * LABEL_PADDING),
            });
      return {
        w: Math.min(maxWidth, Math.max(kind.minSize.w, snap(measured.w + 2 * LABEL_PADDING))),
        h: Math.max(kind.minSize.h, snap(measured.h + 2 * LABEL_PADDING)),
      };
    }
    case "text": {
      const fontSize = TEXT_FONT_SIZES[kind.size];
      // A row can squeeze a fill child to nothing; text still wraps in at least a pixel.
      const measured = measure(text, { family, fontSize, maxWidth: Math.max(1, maxWidth) });
      // tldraw sizes text one pixel wider than measured so it does not wrap.
      return {
        w: Math.min(maxWidth, Math.ceil(measured.w) + 1),
        h: snap(Math.max(fontSize, measured.h)),
      };
    }
    case "line":
      return { w: maxWidth, h: 0 };
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Boxes for every member of a screen, relative to the screen frame of the given size: chrome
 * across the top, then the elements below it, or in a centered sheet over a backdrop for a modal.
 * `textOf` is the text each member shows, which a human may have edited.
 */
export function arrangeScreen(input: {
  readonly screen: StoredNode;
  readonly contents: ScreenContents;
  readonly size: Size;
  readonly family: TextFont["family"];
  readonly measure: MeasureText;
  readonly textOf: (member: StoredNode) => string;
}): Map<string, Box> {
  const { screen: node, contents, size, family, measure } = input;
  const settings = settingsOf(node);
  const members = new Map(contents.members.map((member) => [member.key, member]));
  const sizer = {
    size: (key: string, maxWidth: number): Size => {
      const member = members.get(key);
      const kind = member && contentKindOf(member.kind);
      if (!member || !kind) return { w: 0, h: 0 };
      return leafSize(kind, input.textOf(member), maxWidth, family, measure);
    },
    rigid: (key: string) => RIGID.has(members.get(key)?.kind ?? ""),
  };

  const boxes = new Map<string, Box>();
  let top = 0;
  if (settings.chrome) {
    const chrome = `${node.key}.${CHROME}`;
    top = sizer.size(chrome, size.w).h;
    boxes.set(chrome, { x: 0, y: 0, w: size.w, h: top });
  }
  let area: Box = { x: 0, y: top, w: size.w, h: size.h - top };
  if (settings.modal) {
    boxes.set(`${node.key}.${BACKDROP}`, { x: 0, y: 0, w: size.w, h: size.h });
    const w = Math.min(size.w - 2 * MODAL_MARGIN, MODAL_MAX_WIDTH);
    const h = naturalSize(contents.root, w, sizer).h;
    area = { x: (size.w - w) / 2, y: Math.max(top + MODAL_MARGIN, (size.h - h) / 2), w, h };
  }
  for (const [key, box] of arrangeStack(contents.root, area, sizer)) boxes.set(key, box);
  return boxes;
}

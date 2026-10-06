import type { DiagramKit } from "@t3tools/contracts";

import type { Kit } from "../kit.ts";
import { architecture } from "./architecture.ts";
import { c4 } from "./c4.ts";
import { er } from "./er.ts";
import { flow } from "./flow.ts";
import { sequence } from "./sequence.ts";
import { state } from "./state.ts";
import { umlClass } from "./uml-class.ts";
import { userFlow } from "./user-flow.ts";
import { wireframe } from "./wireframe.ts";

export const KITS: { readonly [K in DiagramKit]: Kit } = {
  flow,
  state,
  "uml-class": umlClass,
  er,
  c4,
  architecture,
  wireframe,
  sequence,
  "user-flow": userFlow,
};

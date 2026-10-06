import type { DiagramKit } from "@t3tools/contracts";

import type { Kit } from "../kit.ts";
import { er } from "./er.ts";
import { flow } from "./flow.ts";
import { state } from "./state.ts";
import { umlClass } from "./uml-class.ts";

export const KITS: { readonly [K in DiagramKit]: Kit } = { flow, state, "uml-class": umlClass, er };

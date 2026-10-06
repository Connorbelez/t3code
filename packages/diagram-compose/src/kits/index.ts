import type { DiagramKit } from "@t3tools/contracts";

import type { Kit } from "../kit.ts";
import { flow } from "./flow.ts";

export const KITS: { readonly [K in DiagramKit]: Kit } = { flow };

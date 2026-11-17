/* The event side sheet, fetched when a row is first opened. It carries the whole event page's parts (about 300 kB), which Overview, Events, Results, Budget and Usage
   do not need to draw their own lists. */

import { Suspense, lazy, type ComponentProps } from "react";
import type { SideSheet as Real } from "./SideSheet";

const Sheet = lazy(() => import("./SideSheet").then((m) => ({ default: m.SideSheet })));

export function SideSheet(props: ComponentProps<typeof Real>) {
  return <Suspense fallback={null}><Sheet {...props} /></Suspense>;
}

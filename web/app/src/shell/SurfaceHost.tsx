import type { ReactNode } from "react";
import { SurfaceActiveContext } from "./activity.tsx";
import { useRouter } from "./router.ts";
import type { SurfaceId } from "./routes.ts";
import { SURFACES } from "./surfaces.ts";

interface Props {
  /** How to draw each surface. Called once a surface has been visited, and kept. */
  render: Record<SurfaceId, () => ReactNode>;
}

/**
 * Every surface, stacked in one place. A surface is built the first time it
 * is visited and never torn down after: moving away hides it, so the editor
 * keeps its frame, the terminals keep their sockets and a half-typed filter
 * is still there when you come back.
 *
 * The list of sections is fixed — one per surface, empty until visited — so a
 * newly visited surface never shifts the others in the DOM (moving an iframe
 * reloads it). A hidden surface keeps its size (`visibility`, not `display`),
 * so terminals do not see a zero-sized box and resize herdr's panes for every
 * viewer; it is `inert` and hidden from assistive technology.
 */
export function SurfaceHost({ render }: Props) {
  const current = useRouter((s) => s.route.surface);
  const mounted = useRouter((s) => s.mounted);
  return (
    <div className="surfaces">
      {SURFACES.map(({ id, label }) => {
        const active = id === current;
        return (
          <section
            key={id}
            className="surface"
            data-surface={id}
            data-active={active ? "" : undefined}
            aria-label={label}
            aria-hidden={active ? undefined : true}
            inert={!active}
          >
            <SurfaceActiveContext.Provider value={active}>{mounted.includes(id) ? render[id]() : null}</SurfaceActiveContext.Provider>
          </section>
        );
      })}
    </div>
  );
}

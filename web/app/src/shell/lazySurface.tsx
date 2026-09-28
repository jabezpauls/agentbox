import { lazy, type ComponentType } from "react";
import { Empty } from "../components/ui/Page.tsx";

/** What a surface shows when its code could not be fetched. */
function Unloadable() {
  return (
    <div className="page">
      <div className="page-inner">
        <Empty
          title="Couldn't load this part of the app."
          sub="The box may have been updated since this page was opened, or the connection dropped."
          action={
            <button className="btn btn-small btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          }
        />
      </div>
    </div>
  );
}

/**
 * A surface whose code is its own chunk, fetched on the first visit. A chunk
 * that cannot be fetched — the box updated underneath an open page, whose old
 * chunk names are gone, or the network down — shows a Reload instead of
 * taking the whole app down with it.
 */
export function lazySurface<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch {
      return { default: Unloadable as ComponentType<P> };
    }
  });
}

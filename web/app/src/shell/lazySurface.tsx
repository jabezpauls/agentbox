import { createContext, lazy, useContext, useReducer, type ComponentType, type LazyExoticComponent } from "react";
import { Empty } from "../components/ui/Page.tsx";

/** How a surface that failed to load asks for its code again. */
const RetryContext = createContext<() => void>(() => {});

/** What a surface shows when its code could not be fetched. */
function Unloadable() {
  const retry = useContext(RetryContext);
  return (
    <div className="page">
      <div className="page-inner">
        <Empty
          title="Couldn't load this part of the app."
          sub="The connection may have dropped, or the box was updated since this page was opened. If trying again does not help, reload the page."
          action={
            <button className="btn btn-small btn-primary" onClick={retry}>
              Try again
            </button>
          }
        />
      </div>
    </div>
  );
}

/**
 * A surface whose code is its own chunk, fetched on the first visit. A chunk
 * that cannot be fetched — the network down, or the box updated underneath an
 * open page — shows a Try again instead of taking the whole app down with it.
 * Trying again imports afresh (React.lazy would hand back its first, failed
 * answer for good), and without reloading the page, which would drop what
 * the rest of it holds — uploads under way above all.
 */
export function lazySurface<P extends object>(load: () => Promise<ComponentType<P>>) {
  const make = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch {
        return { default: Unloadable as ComponentType<P> };
      }
    });
  let current = make();

  function Surface(props: P) {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const retry = () => {
      // A fresh lazy component, so the next render imports again.
      current = make();
      rerender();
    };
    const Current = current;
    return (
      <RetryContext.Provider value={retry}>
        <Current {...props} />
      </RetryContext.Provider>
    );
  }
  return Surface;
}

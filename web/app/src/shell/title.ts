/**
 * The document title: which surface is showing, and how many agents are
 * waiting — so a background tab still says "(2) Files · agentbox" when two
 * agents need you.
 */
let surface = "Home";
let waiting = 0;

function apply(): void {
  if (typeof document === "undefined") return;
  document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${surface} · agentbox`;
}

export function setTitleSurface(label: string): void {
  surface = label;
  apply();
}

export function setTitleCount(n: number): void {
  waiting = n;
  apply();
}

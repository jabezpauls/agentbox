// Markdown files bundled as text (esbuild loader "text"; a vitest plugin in tests).
declare module "*.md" {
  const text: string;
  export default text;
}

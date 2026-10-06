// The template and prompts, bundled as strings (see "rules" in wrangler.jsonc).
declare module "*.md" { const text: string; export default text; }
declare module "*.html" { const text: string; export default text; }

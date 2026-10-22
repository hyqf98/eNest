/* Main-process theme consumers use Vite's raw CSS loader, not a runtime CSS import. */
declare module '*.css?raw' {
  const css: string
  export default css
}

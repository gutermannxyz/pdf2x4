// Ambient-Deklarationen für Ghostscript-WASM und Vites ?url-Import.
declare module "@jspawn/ghostscript-wasm/gs.js" {
  const factory: (opts?: any) => Promise<any>;
  export default factory;
}
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
declare module "@jspawn/ghostscript-wasm/gs.wasm?url" {
  const url: string;
  export default url;
}

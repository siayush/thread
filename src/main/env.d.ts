/** electron-vite resolves `?asset` imports to a runtime file path (string). */
declare module '*?asset' {
  const assetPath: string
  export default assetPath
}

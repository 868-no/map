// gzip in the browser (CompressionStream): the cache's texts, compressed once each.
export const gzip = (text: string) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
export const gunzip = (b: Blob) => new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text()

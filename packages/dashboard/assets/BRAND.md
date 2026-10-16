# Wholesale by Mercaria

`wholesale.svg` is copied byte-for-byte from Oxy Website:
`website/public/images/apps/wholesale.svg`. Website's Platform menu selects it
in `website/src/data/content.ts`, with `preserveImageColors: true`.

SHA-256: `500cc3459313f37a9d6d807742cce6b7c6f641448090ee61fbb4063a43e1955f`.

The 192px and 512px PNGs, splash and favicon are raster exports of that SVG,
using Sharp without recoloring. The adaptive foreground adds safe-area padding
on the original orange; the Android monochrome mask uses the original path's
alpha without the background circle. No new logo was drawn.

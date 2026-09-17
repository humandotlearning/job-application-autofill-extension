const MAX_EDGE = 1600;
const MAX_BYTES = 750_000;

function clipped(rect, viewport) {
  if (!rect || !viewport || ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite)) return null;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  return right > left && bottom > top ? {x: left, y: top, width: right - left, height: bottom - top} : null;
}

function union(rects) {
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return {x: left, y: top, width: right - left, height: bottom - top};
}

async function blobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export async function prepareFormScreenshot(
  {dataUrl, viewport, regions = [], redactions = []},
  {fetchImpl = fetch, createImageBitmapImpl = createImageBitmap, OffscreenCanvasImpl = OffscreenCanvas} = {},
) {
  const visibleRegions = regions.map(region => clipped(region.rect || region, viewport)).filter(Boolean);
  if (!String(dataUrl || '').startsWith('data:image/') || !visibleRegions.length || !viewport?.width || !viewport?.height) return null;
  const bounds = union(visibleRegions);
  const response = await fetchImpl(dataUrl);
  if (!response.ok) return null;
  const bitmap = await createImageBitmapImpl(await response.blob());
  try {
    const pixelScaleX = bitmap.width / viewport.width;
    const pixelScaleY = bitmap.height / viewport.height;
    if (![pixelScaleX, pixelScaleY].every(value => Number.isFinite(value) && value > 0)) return null;
    const longest = Math.max(bounds.width * pixelScaleX, bounds.height * pixelScaleY);
    const outputScale = Math.min(1, MAX_EDGE / longest);
    const width = Math.max(1, Math.round(bounds.width * pixelScaleX * outputScale));
    const height = Math.max(1, Math.round(bounds.height * pixelScaleY * outputScale));
    const canvas = new OffscreenCanvasImpl(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#d9d9d9';
    context.fillRect(0, 0, width, height);
    for (const region of visibleRegions) {
      context.drawImage(bitmap,
        region.x * pixelScaleX, region.y * pixelScaleY, region.width * pixelScaleX, region.height * pixelScaleY,
        (region.x - bounds.x) * pixelScaleX * outputScale, (region.y - bounds.y) * pixelScaleY * outputScale,
        region.width * pixelScaleX * outputScale, region.height * pixelScaleY * outputScale);
    }
    context.fillStyle = '#6b7280';
    for (const raw of redactions) {
      const rect = clipped(raw, viewport);
      if (!rect) continue;
      context.fillRect(
        (rect.x - bounds.x) * pixelScaleX * outputScale,
        (rect.y - bounds.y) * pixelScaleY * outputScale,
        rect.width * pixelScaleX * outputScale,
        rect.height * pixelScaleY * outputScale,
      );
    }
    for (const quality of [0.82, 0.6, 0.4]) {
      const blob = await canvas.convertToBlob({type: 'image/jpeg', quality});
      if (blob.size <= MAX_BYTES) return {dataUrl: await blobDataUrl(blob), width, height};
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

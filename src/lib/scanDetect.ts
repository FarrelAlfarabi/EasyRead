/** Minimal slice of a pdf.js page used here (kept loose so Node tests can pass a real page). */
interface PageLike {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getViewport(o: { scale: number }): { width: number; height: number };
}

/**
 * A scanned page whose text came from the scanner's OCR: text drawn invisibly (render mode 3)
 * over a page image, or text on top of an image that covers most of the page.
 * `OPS` is pdf.js's operator table.
 */
export async function looksLikeScanWithTextLayer(page: PageLike, OPS: Record<string, number>): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    const vp = page.getViewport({ scale: 1 });
    const pageArea = vp.width * vp.height;
    let invisibleText = false;
    let bigImage = false;
    // Images are drawn into a unit square scaled by the current transform, so track it.
    const stack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (a: number[], b: number[]) => [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat]);
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args as number[]);
      else if (fn === OPS.setTextRenderingMode && args?.[0] === 3) invisibleText = true;
      else if (images.has(fn) && Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) > pageArea * 0.5) bigImage = true;
      if (invisibleText && bigImage) break;
    }
    return invisibleText || bigImage;
  } catch {
    return false;
  }
}

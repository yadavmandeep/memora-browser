import type { Page } from 'playwright-core';
import type { VisualElementBox, VisionSnapshot, VisionOptions } from '../types/index.js';

export async function captureVisionSnapshot(page: Page, options: VisionOptions = {}): Promise<VisionSnapshot> {
  const {
    format = 'png',
    quality = 80,
    withOverlay = true,
    maxElements = 60,
    clip
  } = options;

  // 1. Scan page for interactive elements and compute bounding boxes
  const detected = await page.evaluate(({ max }) => {
    const selector = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [onclick], canvas';
    const all = Array.from(document.querySelectorAll(selector));
    const results: any[] = [];
    const canvasFound = !!document.querySelector('canvas');

    for (const el of all) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      // Check visibility & viewport overlap
      if (
        rect.width > 4 &&
        rect.height > 4 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        parseFloat(style.opacity || '1') > 0.05 &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
      ) {
        let text = (el.textContent || (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '').trim();
        if (text.length > 50) text = text.slice(0, 47) + '...';

        results.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          text,
          box: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          center: {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          }
        });

        if (results.length >= max) break;
      }
    }

    return { results, canvasFound };
  }, { max: maxElements });

  const elements: VisualElementBox[] = detected.results.map((r, i) => ({
    id: `@v${i + 1}`,
    ...r
  }));

  // 2. Inject visual overlay if withOverlay: true
  if (withOverlay && elements.length > 0) {
    await page.evaluate((boxes) => {
      const overlay = document.createElement('div');
      overlay.id = '__orbis_vision_overlay__';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;font-family:sans-serif;';

      for (const item of boxes) {
        // Outline box
        const boxDiv = document.createElement('div');
        boxDiv.style.cssText = `position:absolute;left:${item.box.x}px;top:${item.box.y}px;width:${item.box.width}px;height:${item.box.height}px;border:2px dashed #00e5ff;box-sizing:border-box;pointer-events:none;`;

        // Badge tag
        const badge = document.createElement('span');
        badge.textContent = item.id;
        const badgeTop = Math.max(0, item.box.y - 18);
        badge.style.cssText = `position:absolute;left:${item.box.x}px;top:${badgeTop}px;background:#00e5ff;color:#000;font-size:10px;font-weight:900;padding:1px 4px;border-radius:2px;box-shadow:0 1px 3px rgba(0,0,0,0.5);pointer-events:none;`;

        boxDiv.appendChild(badge);
        overlay.appendChild(boxDiv);
      }
      document.body.appendChild(overlay);
    }, elements);
  }

  // 3. Take screenshot
  const screenshotOpts: any = {
    type: format === 'jpeg' ? 'jpeg' : 'png',
    clip
  };
  if (format === 'jpeg') screenshotOpts.quality = quality;

  const imageBuffer = await page.screenshot(screenshotOpts);

  // 4. Remove overlay immediately
  if (withOverlay) {
    await page.evaluate(() => {
      const overlay = document.getElementById('__orbis_vision_overlay__');
      if (overlay) overlay.remove();
    }).catch(() => {});
  }

  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const base64DataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  return {
    imageBuffer,
    mimeType,
    width: viewport.width,
    height: viewport.height,
    elements,
    hasCanvas: detected.canvasFound,
    base64DataUri
  };
}

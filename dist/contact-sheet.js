import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, loadPlaywright } from './screenshot.js';
const SHEET_WIDTH = 1500;
function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
/**
 * Renders every image into one labelled grid so a reviewer looks at a single
 * picture instead of many. Returns undefined when Playwright is unavailable.
 */
export async function makeContactSheet(files, out, title) {
    const images = files.filter((f) => fs.existsSync(f));
    if (!images.length)
        return undefined;
    const pw = await loadPlaywright();
    if (!pw)
        return undefined;
    // Tall screenshots get a narrower column so the sheet stays compact.
    const columns = images.length <= 2 ? images.length : images.length <= 8 ? 4 : 6;
    const cells = images
        .map((f) => `<figure><img src="${pathToFileURL(f).href}"><figcaption>${escapeHtml(path.basename(f))}</figcaption></figure>`)
        .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 12px; font: 13px system-ui, sans-serif; background: #fff; width: ${SHEET_WIDTH - 24}px; }
    h1 { font-size: 15px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 10px; align-items: start; }
    figure { margin: 0; border: 1px solid #ccc; }
    img { display: block; width: 100%; max-height: 640px; object-fit: contain; object-position: top; background: #f4f4f4; }
    figcaption { padding: 3px 6px; background: #eee; overflow-wrap: anywhere; }
  </style></head><body><h1>${escapeHtml(title)}</h1><div class="grid">${cells}</div></body></html>`;
    const htmlFile = out.replace(/\.png$/, '.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(htmlFile, html);
    const browser = await launchBrowser(pw);
    try {
        const page = await browser.newPage({ viewport: { width: SHEET_WIDTH, height: 900 } });
        await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
        await page.screenshot({ path: out, fullPage: true });
        return out;
    }
    finally {
        await browser.close();
    }
}
//# sourceMappingURL=contact-sheet.js.map
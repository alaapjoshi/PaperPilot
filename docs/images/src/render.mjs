// Renders every *.html here to ../<name>.png at 2x.
// Run from the repo root:  npx -y playwright@1.56.1 install chromium && node docs/images/src/render.mjs
// (Playwright is not a project dependency; it is only needed to regenerate these images.)
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const sizes = { cover: [1280, 640], "cover-linkedin": [1200, 627], logo: [512, 512], "devpost-thumbnail": [1500, 1000] };
const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
for (const file of readdirSync(here).filter((f) => f.endsWith(".html"))) {
  const name = file.replace(/\.html$/, "");
  const [width, height] = sizes[name] ?? [1600, 1000];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto("file://" + join(here, file));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(here, "..", `${name}.png`) });
  await page.close();
  console.log("rendered", name);
}
await browser.close();

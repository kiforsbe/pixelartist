import assert from 'node:assert/strict';

// Run with an owned Playwright page against a local server; see tests/smoke.md.
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function sheetPixels(page) {
  await settle(page);
  return page.locator('#canvas-host > canvas').evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (!data[(y * canvas.width + x) * 4 + 3]) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return maxX < 0 ? { width: 0, height: 0 } : { width: maxX - minX + 1, height: maxY - minY + 1 };
  });
}

export async function verifyInitialSheet(page, url) {
  await page.goto(url);
  await page.locator('#sheet-select option').first().waitFor({ state: 'attached' });
  const pixels = await sheetPixels(page);
  assert.ok(pixels.width > 0 && pixels.height > 0, 'initial sheet checkerboard must render without a mode switch');
}

export async function verifySheetSwitchSizing(page) {
  // Real New Sheet controls, then the same-mode document dropdown. No pointer drags.
  await page.locator('#btn-new-sheet').click();
  await page.locator('#ns-name').fill('Tall sheet');
  await page.locator('#ns-w').fill('64');
  await page.locator('#ns-h').fill('128');
  await page.locator('#ns-create').click();
  const tallId = await page.locator('#sheet-select').inputValue();
  const originalId = await page.locator('#sheet-select option').first().getAttribute('value');
  await page.locator('#sheet-select').selectOption(originalId);
  const square = await sheetPixels(page);
  assert.ok(square.width > 0);
  assert.equal(square.width, square.height, 'original square sheet restores its content bounds');
  await page.locator('#sheet-select').selectOption(tallId);
  const tall = await sheetPixels(page);
  assert.equal(tall.height, tall.width * 2, 'same-mode switch updates checkerboard to the tall sheet bounds');
}

export async function verifyModePanelVisibility(page) {
  for (const mode of ['sprites', 'tiles', 'sprites', 'maps', 'tiles', 'sprites']) {
    await page.locator(`#tab-${mode}`).click();
    await settle(page);
    for (const id of ['panel-autotiles', 'panel-tilelayers']) {
      const panel = await page.locator(`#${id}`).evaluate(element => ({
        hidden: element.hidden, display: getComputedStyle(element).display,
        height: element.getBoundingClientRect().height,
      }));
      assert.equal(panel.hidden, mode !== 'tiles', `${id} hidden in ${mode}`);
      if (mode !== 'tiles') {
        assert.equal(panel.display, 'none');
        assert.equal(panel.height, 0, `${id} must leave no empty panel space`);
      }
    }
    assert.equal(await page.locator('#panel-context').isVisible(), true, 'shared contextual panel stays visible');
  }
}

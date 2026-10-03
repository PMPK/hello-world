import { expect, test, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
type PX = any;

async function px<T>(page: Page, fn: (px: PX) => T): Promise<T> {
  return page.evaluate((src) => {
    const f = new Function('px', `return (${src})(px);`);
    return f((window as any).__PX);
  }, fn.toString()) as Promise<T>;
}

async function tap(page: Page, x: number, y: number, touch: boolean): Promise<void> {
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Issue a command: tap on touch screens, right-click with a mouse. */
async function command(page: Page, x: number, y: number, touch: boolean): Promise<void> {
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y, { button: 'right' });
}

test('full loop: campaign → move army → tactical battle → back to campaign → save/continue', async ({ page }, info) => {
  const touch = info.project.name.includes('touch');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  // 1. launch
  await page.goto('/');
  await expect(page.getByTestId('new-campaign')).toBeVisible();

  // 2. start a campaign
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  const day0 = await px(page, (p) => p.state().time);
  expect(day0).toBeGreaterThanOrEqual(0);

  // let the campaign run a moment, then pause for deterministic input
  await page.waitForTimeout(1500);
  await page.getByTestId('speed-0').click();

  // 3. select the player's task force by tapping it on screen
  const armyId: string = await px(page, (p) => {
    const s = p.state();
    return Object.values(s.armies as Record<string, any>).find((a: any) => a.factionId === s.playerFactionId)!.id;
  });
  await px(page, (p) => {
    const s = p.state();
    const a = Object.values(s.armies as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId);
    p.app.campaign.focusOn(a.x, a.z, 40);
  });
  await page.waitForTimeout(1200);
  const pos = await px(page, (p) => {
    const s = p.state();
    const a = Object.values(s.armies as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId);
    return p.app.campaign.view.armyScreenPos(a.id);
  });
  expect(pos).not.toBeNull();
  await tap(page, pos.x, pos.y + 18, touch);
  await expect(page.getByTestId('side-panel')).toBeVisible();
  const selected = await px(page, (p) => p.app.campaign.selection);
  expect(selected?.kind).toBe('army');
  expect(selected?.id).toBe(armyId);

  // 4. move it: tap open ground near the army
  const before = await px(page, (p) => {
    const a = p.state().armies[p.app.campaign.selection.id];
    return { x: a.x, z: a.z };
  });
  const vp = page.viewportSize()!;
  let ordered = false;
  for (const [dx, dy] of [[-160, 40], [-120, -60], [120, 80], [-200, 0], [0, 110]]) {
    await command(page, Math.max(40, Math.min(vp.width - 380, pos.x + dx)), Math.max(80, Math.min(vp.height - 40, pos.y + dy)), touch);
    await page.waitForTimeout(250);
    ordered = await px(page, (p) => {
      const a = p.state().armies[p.app.campaign.selection?.id ?? ''];
      return !!a && a.path.length > 0;
    });
    if (ordered) break;
    // re-select if the tap cleared the selection
    await px(page, (p) => {
      const s = p.state();
      const a = Object.values(s.armies as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId);
      p.app.campaign.select({ kind: 'army', id: a.id });
    });
  }
  expect(ordered).toBe(true);
  await page.getByTestId('speed-4').click();
  await page.waitForTimeout(2500);
  const after = await px(page, (p) => {
    const s = p.state();
    const a = Object.values(s.armies as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId);
    return { x: a.x, z: a.z };
  });
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.2);

  // 5. contact → tactical battle
  expect(await px(page, (p) => p.debugContact('field'))).toBe(true);
  await expect(page.getByTestId('command-battle')).toBeVisible();
  await page.getByTestId('command-battle').click();
  await expect(page.getByTestId('withdraw')).toBeVisible();
  expect(await px(page, (p) => p.battle() !== null)).toBe(true);
  const timeAtBattleStart = await px(page, (p) => p.state().time);

  // command our units: select all, then tap the ground ahead to move
  await page.getByTestId('cmd-all').click();
  const selCount = await px(page, (p) => p.app.battle.selected.size);
  expect(selCount).toBeGreaterThan(0);
  await command(page, vp.width * 0.45, vp.height * 0.35, touch);
  await page.waitForTimeout(300);
  const moving = await px(page, (p) => p.battle().units.some((u: any) => u.side === p.app.battle.playerSide && u.order.type === 'move'));
  expect(moving).toBe(true);
  await page.waitForTimeout(4000);
  expect(await px(page, (p) => p.battle().time)).toBeGreaterThan(1);

  // 6. withdraw and return
  await page.getByTestId('withdraw').click();
  await page.locator('.modal-back .btn.danger').click();
  await expect(page.getByTestId('return-campaign')).toBeVisible();
  await page.getByTestId('return-campaign').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  const post = await px(page, (p) => ({ battles: p.state().stats.battlesFought, time: p.state().time, pending: p.state().pendingBattle, rel: p.state().relations[0].status }));
  expect(post.battles).toBe(1);
  expect(post.pending).toBeNull();
  expect(post.time).toBeGreaterThan(timeAtBattleStart);
  expect(post.rel).toBe('hostile');
  // close the after-action report
  await page.locator('.modal-back .btn.primary').first().click();

  // 7. save, reload, continue
  await page.getByTestId('menu').click();
  await page.getByRole('button', { name: 'Save game' }).click();
  await page.waitForTimeout(800);
  const savedTime = await px(page, (p) => p.state().time);
  await page.reload();
  await expect(page.getByTestId('continue')).toBeVisible();
  await page.getByTestId('continue').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  const loaded = await px(page, (p) => ({ time: p.state().time, battles: p.state().stats.battlesFought }));
  expect(loaded.battles).toBe(1);
  expect(Math.abs(loaded.time - savedTime)).toBeLessThan(2);

  await page.screenshot({ path: `test-results/smoke-${info.project.name}.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('base assault battle contains the base buildings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  const campaignBuildings: string[] = await px(page, (p) => {
    const s = p.state();
    const base = Object.values(s.bases as Record<string, any>).find((b: any) => b.factionId === s.playerFactionId);
    return Object.values(s.buildings as Record<string, any>)
      .filter((b: any) => b.baseId === base.id && Math.hypot(b.x - base.x, b.z - base.z) < 12)
      .map((b: any) => b.id)
      .sort();
  });
  expect(await px(page, (p) => p.debugContact('base_assault'))).toBe(true);
  await page.getByTestId('command-battle').click();
  await expect(page.getByTestId('withdraw')).toBeVisible();
  const battleBuildings: string[] = await px(page, (p) =>
    p
      .battle()
      .buildings.map((b: any) => b.spec.campaignId)
      .sort(),
  );
  for (const id of campaignBuildings) expect(battleBuildings).toContain(id);
  expect(errors).toEqual([]);
});

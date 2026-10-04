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

/** The first commanded battle opens paused with the controls card; close it. */
async function dismissBattleTips(page: Page): Promise<void> {
  await expect(page.getByTestId('battle-tips')).toBeVisible();
  await page.getByRole('button', { name: 'Got it — start' }).click();
  await expect(page.getByTestId('battle-tips')).toBeHidden();
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
  await dismissBattleTips(page);
  expect(await px(page, (p) => p.app.battle.speed)).toBe(1);
  expect(await px(page, (p) => p.battle() !== null)).toBe(true);
  const timeAtBattleStart = await px(page, (p) => p.state().time);

  // command our units: select all, then tap the ground ahead to move
  await page.getByTestId('cmd-all').click();
  const selCount = await px(page, (p) => p.app.battle.selected.size);
  expect(selCount).toBeGreaterThan(0);
  // unit card: multi-selection grid → single unit details → clear → select all again
  await expect(page.getByTestId('unit-card')).toBeVisible();
  await page.locator('.uc-badge').first().click();
  expect(await px(page, (p) => p.app.battle.selected.size)).toBe(1);
  await expect(page.locator('.uc-weapon').first()).toBeVisible();
  await page.getByTestId('unit-deselect').click();
  await expect(page.getByTestId('unit-card')).toBeHidden();
  expect(await px(page, (p) => p.app.battle.selected.size)).toBe(0);
  await page.getByTestId('cmd-all').click();
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
  await page.getByTestId('save-manual').click();
  await page.waitForTimeout(800);
  const savedTime = await px(page, (p) => p.state().time);
  await page.reload();
  await expect(page.getByTestId('continue')).toBeVisible();
  await page.getByTestId('continue').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  const loaded = await px(page, (p) => ({ time: p.state().time, battles: p.state().stats.battlesFought }));
  expect(loaded.battles).toBe(1);
  expect(Math.abs(loaded.time - savedTime)).toBeLessThan(2);

  // 8. the save slot is listed in Load game, and a save file round-trips through import
  const exported: string = await px(page, (p) => p.app.saves.exportJson(p.state()));
  await page.getByTestId('menu').click();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByTestId('load-game').click();
  await expect(page.getByTestId('load-manual')).toBeVisible();
  await page.locator('.save-paste').fill(exported);
  await page.getByRole('button', { name: 'Import text' }).click();
  await expect(page.getByTestId('menu')).toBeVisible();
  expect(await px(page, (p) => p.state().stats.battlesFought)).toBe(1);

  await page.screenshot({ path: `test-results/smoke-${info.project.name}.png` });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('base assault battle contains the base buildings', async ({ page }, info) => {
  const touch = info.project.name.includes('touch');
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
  // crewed defences take part in the assault
  expect(await px(page, (p) => p.debugFortify(['bunker', 'at_emplacement']))).toBe(2);
  expect(await px(page, (p) => p.debugContact('base_assault'))).toBe(true);
  await page.getByTestId('command-battle').click();
  await expect(page.getByTestId('withdraw')).toBeVisible();
  await dismissBattleTips(page);
  const armed: number = await px(page, (p) => p.battle().buildings.filter((b: any) => b.defense && b.defense.crew > 0 && b.defense.ammo > 0).length);
  expect(armed).toBe(2);
  const battleBuildings: string[] = await px(page, (p) =>
    p
      .battle()
      .buildings.map((b: any) => b.spec.campaignId)
      .sort(),
  );
  for (const id of campaignBuildings) expect(battleBuildings).toContain(id);

  // garrison: select one infantry squad and tap one of our buildings that has room
  const pick = await px(page, (p) => {
    const sim = p.battle();
    const side = p.app.battle.playerSide;
    const squad = sim.units.find((u: any) => u.side === side && u.alive && !u.reserve && u.stats.family === 'infantry');
    const mine = sim.buildings.filter((b: any) => b.side === side && sim.garrisonCapacity(b) > 0);
    // the building least crowded by units, so the tap lands on the structure
    const clear = (b: any): number => Math.min(...sim.units.filter((u: any) => u.alive && !u.reserve).map((u: any) => Math.hypot(u.x - b.x, u.z - b.z)));
    const b = mine.sort((a: any, c: any) => clear(c) - clear(a))[0];
    p.app.battle.speed = 0;
    p.app.battle.selectOnly(squad.id);
    p.app.battle.view.rig.jumpTo(b.x, b.z, 140);
    return { squad: squad.id, building: b.id };
  });
  // the camera jumped onto the building (no easing), so its screen position is final
  await page.waitForTimeout(400);
  const at = await page.evaluate((id) => {
    const p = (window as any).__PX;
    const b = p.battle().buildings.find((x: any) => x.id === id);
    return p.app.battle.view.buildingScreen(b);
  }, pick.building);
  expect(at).toBeTruthy();
  await tap(page, at!.x, at!.y, touch);
  const order = await page.evaluate((id) => {
    const u = (window as any).__PX.battle().units.find((x: any) => x.id === id);
    return { type: u.order.type, building: u.order.buildingId ?? u.inside };
  }, pick.squad);
  expect(order.type === 'garrison' || order.type === 'hold').toBe(true);
  expect(order.building).toBe(pick.building);
  expect(errors).toEqual([]);
});

test('overview navigation, then split a task force and merge it back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.getByTestId('speed-0').click();
  const count = (): Promise<number> =>
    px(page, (p) => Object.values(p.state().armies as Record<string, any>).filter((a: any) => a.factionId === p.state().playerFactionId).length);
  expect(await count()).toBe(1);
  // the expedition overview lists the task force; tapping it selects it
  await page.getByTestId('overview').click();
  await page.getByTestId('overview-army').first().click();
  expect(await px(page, (p) => p.app.campaign.selection?.kind)).toBe('army');
  await page.getByTestId('army-split').click();
  const rows = page.getByTestId('split-unit');
  await rows.nth(0).click();
  await rows.nth(1).click();
  await page.getByTestId('split-confirm').click();
  expect(await count()).toBe(2);
  // the new force is selected; merge it back into its parent
  await page.getByTestId('army-merge').first().click();
  expect(await count()).toBe(1);
  expect(errors).toEqual([]);
});

test('found a new base from the base panel', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.getByTestId('speed-0').click();
  await px(page, (p) => {
    const s = p.state();
    const b = Object.values(s.bases as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId);
    Object.assign(b.stock, { minerals: 600, refined: 400, components: 200, food: 300, fuel: 200, ammo: 120 });
    b.population = 60;
    p.app.campaign.select({ kind: 'base', id: b.id });
  });
  await page.getByTestId('found-base').click();
  await expect(page.getByTestId('confirm-placement')).toBeEnabled();
  await page.getByTestId('confirm-placement').click();
  const n = await px(page, (p) => Object.values(p.state().bases as Record<string, any>).filter((b: any) => b.factionId === p.state().playerFactionId).length);
  expect(n).toBe(2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `test-results/found-base-${info.project.name}.png` });

  // send ore and colonists to the new base with a hand-loaded convoy
  await px(page, (p) => {
    const s = p.state();
    const home = Object.values(s.bases as Record<string, any>).find((x: any) => x.factionId === s.playerFactionId && x.name.startsWith('Landing'));
    p.app.campaign.select({ kind: 'base', id: home.id });
  });
  await page.getByTestId('send-convoy').click();
  await page.getByTestId('convoy-plus-minerals').click();
  await page.getByTestId('convoy-plus-minerals').click();
  await page.getByTestId('convoy-plus-people').click();
  await page.getByTestId('convoy-dispatch').click();
  const convoy = await px(page, (p) => {
    const c = Object.values(p.state().convoys as Record<string, any>).find((x: any) => x.fromBuildingId.startsWith('manual:'));
    return c ? { ore: c.cargo.minerals, people: c.people } : null;
  });
  expect(convoy).toEqual({ ore: 20, people: 2 });
  expect(errors).toEqual([]);
});

test('research lab: pick a project, switch and resume it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.getByTestId('speed-0').click();
  await px(page, (p) => {
    p.debugFortify(['research_lab']);
    const s = p.state();
    const lab = Object.values(s.buildings as Record<string, any>).find((b: any) => b.typeId === 'research_lab');
    p.app.campaign.select({ kind: 'building', id: lab.id });
  });
  const research = (): Promise<any> => px(page, (p) => JSON.parse(JSON.stringify(p.state().factions[p.state().playerFactionId].research)));
  await page.getByTestId('research-hydroponics').click();
  expect((await research()).current.techId).toBe('hydroponics');
  await px(page, (p) => {
    p.state().factions[p.state().playerFactionId].research.current.progress = 9;
  });
  // switching shelves the progress; picking the project again resumes it
  await page.getByTestId('research-deep_drilling').click();
  expect((await research()).shelved).toEqual({ hydroponics: 9 });
  await expect(page.getByTestId('research-hydroponics')).toContainText('9 / 25 RP');
  await page.getByTestId('research-hydroponics').click();
  expect((await research()).current).toEqual({ techId: 'hydroponics', progress: 9 });
  expect(errors).toEqual([]);
});

test('a persistent runtime error stops the game with a way back to the menu', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  page.on('console', () => undefined); // the injected errors are expected
  await px(page, (p) => {
    p.app.campaign.update = () => {
      throw new Error('injected fault');
    };
  });
  await expect(page.getByText('The simulation stopped')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('injected fault')).toBeVisible();
  await page.getByRole('button', { name: 'Main menu' }).click();
  await expect(page.getByTestId('new-campaign')).toBeVisible();
});

test('send a supply run to a task force in the field', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('new-campaign').click();
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.getByTestId('speed-0').click();
  await px(page, (p) => {
    const s = p.state();
    const base = Object.values(s.bases as Record<string, any>).find((b: any) => b.factionId === s.playerFactionId);
    const army = Object.values(s.armies as Record<string, any>).find((a: any) => a.factionId === s.playerFactionId);
    // out in the field, thirsty
    army.x = base.x + 30;
    army.z = base.z + 4;
    for (const u of army.units) u.fuel = Math.min(u.fuel, 3);
    base.stock.fuel = 200;
    p.app.campaign.select({ kind: 'army', id: army.id });
  });
  await page.getByTestId('supply-run').click();
  await page.getByTestId('supply-dispatch').click();
  const run = await px(page, (p) => {
    const c = Object.values(p.state().convoys as Record<string, any>).find((x: any) => x.toArmyId);
    return c ? { fuel: c.cargo.fuel ?? 0 } : null;
  });
  expect(run).not.toBeNull();
  expect(run!.fuel).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

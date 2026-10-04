import * as THREE from 'three';
import { GAME_INFO } from '../config/gameInfo';
import { randomSeed } from '../core/rng';
import { createCampaign, worldForState } from '../campaign/newCampaign';
import { createUnit } from '../campaign/units';
import { makeBuilding, suggestPlacement } from '../campaign/construction';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import type { CampaignState } from '../campaign/types';
import type { World } from '../world/world';
import type { BattleResult, BattleSetup } from '../battle/types';
import { openStore } from '../persistence/kvstore';
import { exportFileName, SaveManager, slotLabel, type SaveInfo, type SaveSlot } from '../persistence/save';
import { loadGameModal, offerFile, saveGameModal } from '../ui/saves';
import { GameRenderer } from '../rendering/renderer';
import { Overlay } from '../rendering/overlay';
import { CampaignView } from '../rendering/campaignView';
import { Keyboard } from '../input/pointer';
import { el } from '../ui/dom';
import { confirmModal, introScreen, mainMenu, openModal, rotateOverlay, settingsModal } from '../ui/screens';
import { AudioEngine } from '../audio/audio';
import { BattleMode } from './battleMode';
import { CampaignMode } from './campaignMode';
import { loadSettings, saveSettings, type Settings } from './settings';

export interface Mode {
  update(dt: number): void;
  render(): void;
  resize(): void;
  dispose(): void;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** Menu background: a slowly orbiting live view of a campaign map. */
class MenuMode implements Mode {
  private view: CampaignView;
  private t = 0;
  constructor(
    private readonly app: App,
    readonly state: CampaignState,
    world: World,
  ) {
    this.view = new CampaignView(app.gr, world, state);
    const home = Object.values(state.bases).find((b) => b.factionId === state.playerFactionId);
    this.view.rig.jumpTo(home?.x ?? 120, home?.z ?? 120, 70);
  }
  update(dt: number): void {
    this.t += dt;
    this.view.rig.rotateBy(dt * 0.05);
    this.view.setHour(17.2); // golden hour for the title screen
    this.view.sync(this.state, dt);
    this.view.update(dt);
    this.app.overlay.clear();
  }
  render(): void {
    this.view.render();
  }
  resize(): void {
    this.view.resize();
  }
  dispose(): void {
    this.view.dispose();
  }
}

/**
 * Top-level game shell: owns the renderer, the main loop, persistence and
 * transitions between menu, campaign and battle modes.
 */
export class App {
  readonly canvas: HTMLCanvasElement;
  readonly gr: GameRenderer;
  readonly overlay: Overlay;
  readonly ui: HTMLElement;
  readonly keyboard = new Keyboard();
  readonly audio = new AudioEngine();
  settings: Settings;
  saves!: SaveManager;
  private mode: Mode | null = null;
  campaign: CampaignMode | null = null;
  battle: BattleMode | null = null;
  private menuScreen: HTMLElement | null = null;
  private last = performance.now();
  private fpsEl: HTMLElement;
  private fpsAcc = { frames: 0, t: 0 };
  private installPrompt: InstallPromptEvent | null = null;
  private saving = false;

  constructor() {
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.ui = document.getElementById('ui') as HTMLElement;
    this.overlay = new Overlay(document.getElementById('overlay') as HTMLCanvasElement);
    this.settings = loadSettings();
    this.gr = new GameRenderer(this.canvas, this.settings.quality);
    this.fpsEl = el('div', 'fps');
    this.fpsEl.style.display = this.settings.showFps ? '' : 'none';
    this.ui.append(this.fpsEl);
    rotateOverlay();
    window.addEventListener('resize', () => this.onResize());
    window.visualViewport?.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.campaign && !this.battle) void this.save('autosave', true);
    });
    // audio may only start from a user gesture; keep resuming (mobile browsers suspend it)
    const unlock = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    this.audio.setVolume(this.settings.soundVolume, this.settings.muted);
    this.ui.addEventListener(
      'click',
      (e) => {
        if ((e.target as HTMLElement | null)?.closest?.('button')) this.audio.ui('click');
      },
      { capture: true },
    );
    this.keyboard.onKey((e) => {
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
        this.settings.muted = !this.settings.muted;
        this.applySettings(this.settings);
      }
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as InstallPromptEvent;
    });
    this.onResize();
  }

  async start(): Promise<void> {
    this.saves = new SaveManager(await openStore());
    await this.showMenu();
    document.getElementById('boot')?.classList.add('hidden');
    setTimeout(() => document.getElementById('boot')?.remove(), 700);
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.audio.beginFrame();
    try {
      this.mode?.update(dt);
      this.mode?.render();
    } catch (err) {
      console.error(err);
    }
    this.fpsAcc.frames++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t >= 0.5) {
      if (this.settings.showFps) this.fpsEl.textContent = `${Math.round(this.fpsAcc.frames / this.fpsAcc.t)} FPS · ${this.gr.renderer.info.render.calls} calls · ${Math.round(this.gr.renderer.info.render.triangles / 1000)}k tris`;
      this.fpsAcc = { frames: 0, t: 0 };
    }
    requestAnimationFrame(this.frame);
  };

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gr.resize(w, h);
    this.overlay.resize(w, h);
    this.mode?.resize();
  }

  private setMode(m: Mode | null): void {
    this.mode = m;
    this.audio.setAmbience(m instanceof BattleMode ? 'battle' : m ? 'campaign' : 'none');
    this.onResize();
  }

  // ---------------------------------------------------------------------------
  // Menu
  // ---------------------------------------------------------------------------

  async showMenu(): Promise<void> {
    this.battle?.dispose();
    this.battle = null;
    this.campaign?.dispose();
    this.campaign = null;
    if (this.mode && this.mode instanceof MenuMode) this.mode.dispose();
    this.ui.querySelectorAll('.modal-back').forEach((m) => m.remove());
    this.menuScreen?.remove();
    let latest: SaveInfo | null = null;
    let preview: { state: CampaignState; world: World } | null = null;
    try {
      latest = await this.saves.latest();
      if (latest) {
        const save = await this.saves.load(latest.slot);
        if (save) preview = { state: save.state, world: worldForState(save.state) };
      }
    } catch (err) {
      console.warn('Could not read saves', err);
      latest = null;
    }
    if (!preview) preview = createCampaign(2000);
    this.setMode(new MenuMode(this, preview.state, preview.world));
    const loaded = latest ? preview : null;
    const fs = document.fullscreenEnabled
      ? () => {
          void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).then(
            () => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined),
            () => undefined,
          );
        }
      : null;
    this.menuScreen = mainMenu(this.ui, latest, {
      onContinue: loaded ? () => this.enterCampaign(loaded.state, loaded.world) : null,
      onNew: () => {
        if (latest) {
          confirmModal(this.ui, 'Start a new campaign?', 'Your current campaign save will be overwritten by the next save.', 'New campaign', () => this.newCampaign(), true);
        } else this.newCampaign();
      },
      onLoad: () => void this.openLoadMenu(),
      onSettings: () => settingsModal(this.ui, this.settings, (s) => this.applySettings(s)),
      onReset: latest
        ? () =>
            confirmModal(this.ui, 'Reset campaign?', 'All saved progress will be permanently deleted.', 'Delete saves', () => {
              void this.saves.clear().then(() => this.showMenu());
            }, true)
        : null,
      onFullscreen: fs,
      onInstall: this.installPrompt
        ? () => {
            void this.installPrompt?.prompt();
            this.installPrompt = null;
          }
        : null,
    });
  }

  private async openLoadMenu(): Promise<void> {
    let saves: SaveInfo[] = [];
    try {
      saves = await this.saves.list();
    } catch {
      saves = [];
    }
    loadGameModal(this.ui, saves, {
      onLoad: (slot) => void this.loadSlot(slot),
      onDelete: (slot) =>
        confirmModal(this.ui, `Delete ${slotLabel(slot)}?`, 'This saved campaign will be permanently removed from this browser.', 'Delete', () => {
          void this.saves.delete(slot).then(() => this.showMenu());
        }, true),
      onImport: async (json) => {
        try {
          const save = await this.saves.importJson(json);
          this.enterCampaign(save.state, worldForState(save.state));
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : 'Import failed.';
        }
      },
    });
  }

  private async loadSlot(slot: SaveSlot): Promise<void> {
    try {
      const save = await this.saves.load(slot);
      if (save) this.enterCampaign(save.state, worldForState(save.state));
    } catch (err) {
      openModal(this.ui, {
        title: 'Could not load save',
        body: [err instanceof Error ? err.message : String(err)],
        actions: [{ label: 'OK', onClick: () => undefined }],
      });
    }
  }

  /** Pause menu → Save game: pick a slot or export a portable save. */
  private async openSaveMenu(resume: () => void): Promise<void> {
    const c = this.campaign;
    if (!c) return;
    let saves: SaveInfo[] = [];
    try {
      saves = await this.saves.list();
    } catch {
      saves = [];
    }
    saveGameModal(this.ui, saves, {
      onSave: (slot) => void this.save(slot).then(resume),
      onExport: () => {
        void offerFile(exportFileName(c.state), this.saves.exportJson(c.state)).then((r) => {
          if (r === 'saved') c.hud.toast('Save file exported.', 'econ');
          else if (r === 'blocked') c.hud.toast('Downloads are blocked here — use Copy to clipboard.', 'warn');
        });
      },
      onCopy: () => {
        const json = this.saves.exportJson(c.state);
        const done = (ok: boolean): void => c.hud.toast(ok ? 'Save copied — paste it into Load game → Import on any device.' : 'Clipboard unavailable in this browser.', ok ? 'econ' : 'warn');
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(json).then(() => done(true), () => done(false));
        else done(false);
      },
    });
  }

  private newCampaign(): void {
    this.menuScreen?.remove();
    this.menuScreen = null;
    const loading = el('div', { class: 'modal-back', html: '<div class="boot-sub">GENERATING PLANET…</div>' });
    this.ui.append(loading);
    setTimeout(() => {
      const { state, world } = createCampaign(randomSeed());
      loading.remove();
      introScreen(this.ui, () => {
        this.settings.introSeen = true;
        saveSettings(this.settings);
        this.enterCampaign(state, world);
        void this.save('autosave', true);
      });
    }, 30);
  }

  enterCampaign(state: CampaignState, world: World): void {
    this.menuScreen?.remove();
    this.menuScreen = null;
    if (this.mode instanceof MenuMode) this.mode.dispose();
    this.campaign?.dispose();
    this.campaign = new CampaignMode(this, state, world);
    this.setMode(this.campaign);
  }

  applySettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    this.gr.applyQuality(s.quality);
    this.audio.setVolume(s.soundVolume, s.muted);
    this.fpsEl.style.display = s.showFps ? '' : 'none';
    this.onResize();
  }

  openPauseMenu(): void {
    const c = this.campaign;
    if (!c) return;
    const prev = c.speed;
    c.setSpeed(0);
    openModal(this.ui, {
      kicker: GAME_INFO.title,
      title: 'Command menu',
      body: [el('div', { class: 'hint', text: 'The campaign is paused. Progress autosaves regularly.' })],
      dismissable: false,
      actions: [
        { label: 'Resume', cls: 'primary', onClick: () => c.setSpeed(prev || 1) },
        {
          label: 'Save game',
          onClick: () => {
            void this.openSaveMenu(() => c.setSpeed(prev || 1));
          },
        },
        {
          label: 'Settings',
          onClick: () =>
            settingsModal(this.ui, this.settings, (s) => this.applySettings(s), {
              onReset: () =>
                confirmModal(this.ui, 'Reset campaign?', 'All saved progress will be permanently deleted and you will return to the main menu.', 'Delete saves', () => {
                  void this.saves.clear().then(() => this.showMenu());
                }, true),
            }),
        },
        {
          label: 'Main menu',
          onClick: () => {
            void this.save('autosave', true).then(() => this.showMenu());
          },
        },
      ],
    });
  }

  async save(slot: SaveSlot, silent = false): Promise<void> {
    const c = this.campaign;
    if (!c || this.saving) return;
    this.saving = true;
    try {
      await this.saves.save(c.state, slot);
      if (!silent) c.hud.toast(slot === 'autosave' ? 'Autosaved.' : `Campaign saved to ${slotLabel(slot)}.`, 'econ');
    } catch (err) {
      console.error('Save failed', err);
      c.hud.toast('Save failed — storage unavailable.', 'warn');
    } finally {
      this.saving = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Battle
  // ---------------------------------------------------------------------------

  startBattle(setup: BattleSetup): void {
    const c = this.campaign;
    if (!c) return;
    this.ui.querySelectorAll('.modal-back').forEach((m) => m.remove());
    c.suspend();
    this.battle = new BattleMode(this, setup, c.world.terrain, (result) => this.endBattle(setup, result));
    this.setMode(this.battle);
  }

  private endBattle(setup: BattleSetup, result: BattleResult): void {
    const c = this.campaign;
    this.battle?.dispose();
    this.battle = null;
    if (!c) return;
    c.resume();
    this.setMode(c);
    c.finishBattle(setup, result);
  }
}

/**
 * Create a contact between the player's first task force and a hostile force
 * (debug/testing aid). Returns false when there is no player army.
 */
function debugContact(app: App, kind: 'field' | 'base_assault'): boolean {
  const c = app.campaign;
  if (!c) return false;
  const s = c.state;
  const pf = s.playerFactionId;
  const ef = Object.keys(s.factions).find((f) => f !== pf);
  const mine = Object.values(s.armies).find((a) => a.factionId === pf);
  const home = Object.values(s.bases).find((b) => b.factionId === pf);
  if (!ef || !mine || !home) return false;
  const units = ['rifle_squad', 'rifle_squad', 'recon_jeep', 'mbt'].map((d) => createUnit(s, d));
  const at = kind === 'base_assault' ? home : mine;
  const enemy = {
    ...mine,
    id: `dbg${s.nextId++}`,
    name: 'Group Debug',
    factionId: ef,
    units,
    commanderId: null,
    x: at.x + 1.5,
    z: at.z,
    path: [],
    order: { type: 'idle' as const },
    homeBaseId: null,
    aiRole: 'attack' as const,
  };
  s.armies[enemy.id] = enemy;
  if (s.ai[ef]) s.ai[ef].nextThinkAt = s.time + 48;
  s.pendingBattle = {
    id: `dbgbt${s.nextId++}`,
    kind,
    x: at.x,
    z: at.z,
    attackerFactionId: ef,
    defenderFactionId: pf,
    attackerArmyIds: [enemy.id],
    defenderArmyIds: kind === 'field' ? [mine.id] : [],
    baseId: kind === 'base_assault' ? home.id : null,
    buildingId: null,
    createdAt: s.time,
    seed: 4242,
  };
  return true;
}

/**
 * Instantly add finished, crewed defences to the player's base on the side
 * facing the enemy (debug/testing aid). Returns the number placed.
 */
function debugFortify(app: App, types: BuildingTypeId[] = ['bunker', 'at_emplacement']): number {
  const c = app.campaign;
  if (!c) return 0;
  const s = c.state;
  const home = Object.values(s.bases).find((b) => b.factionId === s.playerFactionId);
  const enemyBase = Object.values(s.bases).find((b) => b.factionId !== s.playerFactionId);
  if (!home) return 0;
  const toward = enemyBase ? Math.atan2(enemyBase.z - home.z, enemyBase.x - home.x) : 0;
  let n = 0;
  types.forEach((t, k) => {
    const a = toward + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
    const r = home.radius - 1.6;
    const spot = suggestPlacement(s, c.world, home, t, home.x + Math.cos(a) * r, home.z + Math.sin(a) * r);
    if (!spot) return;
    const b = makeBuilding(s, t, home, spot.x, spot.z, Math.atan2(spot.x - home.x, spot.z - home.z), null, true);
    b.workers = BUILDINGS[t].workers;
    s.buildings[b.id] = b;
    n++;
  });
  home.stock.ammo = Math.max(home.stock.ammo, 80);
  return n;
}

/** Expose a small debug/test API on window (used by the Playwright smoke test). */
export function exposeDebug(app: App): void {
  (window as unknown as { __PX: unknown }).__PX = {
    app,
    three: THREE.REVISION,
    state: () => app.campaign?.state ?? null,
    battle: () => app.battle?.sim ?? null,
    debugContact: (kind: 'field' | 'base_assault' = 'field') => debugContact(app, kind),
    debugFortify: (types?: BuildingTypeId[]) => debugFortify(app, types),
  };
}

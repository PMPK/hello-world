/**
 * Central place for the (temporary) game identity.
 * Change the title here and it propagates to the HTML title, PWA manifest,
 * main menu and save metadata.
 */
export const GAME_INFO = {
  title: 'PLANET X',
  shortTitle: 'Planet X',
  subtitle: 'Classified Expedition Command',
  description:
    'Year 2000. A second habitable world has been secretly discovered inside the Solar System. Command a classified expedition.',
  version: '0.1.0',
  themeColor: '#0b0f10',
  backgroundColor: '#07090a',
} as const;

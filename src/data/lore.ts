/** Minimal lore for the MVP. Later chapters (Earth war, aliens) are intentionally absent. */
export const INTRO_LINES: string[] = [
  'YEAR 2000.',
  'A second habitable world has secretly been discovered within the Solar System.',
  'The discovery has been concealed from the public.',
  'Several governments have established classified expeditions on the planet.',
  'Officially, Planet X does not exist.',
  'For now, the expeditions have been ordered to avoid open conflict.',
  'Earth communication is becoming increasingly unstable.',
];

export const INTRO_SIGNOFF = 'You are the Expedition Director of MERIDIAN. Build. Hold. Endure.';

/** Flavour lines for supply flights from Earth (later ones hint at trouble). */
export const EARTH_FLIGHT_MESSAGES = [
  'Supply shuttle landed. New personnel have arrived from Earth.',
  'Supply shuttle landed late. Crew reports unusual military traffic in orbit.',
  'Shuttle arrived with half its manifest. Earth liaison would not comment.',
  'A shuttle landed unannounced. The pilots asked not to be sent back.',
];

export const EARTH_SILENCE_MESSAGES = [
  'Uplink to Earth dropped for 6 hours. Cause unknown.',
  'Earth relay is broadcasting only carrier tone.',
  'Scheduled briefing from Earth did not happen.',
  'Encrypted traffic from Earth contained only a repeated authentication request.',
];

/** `{enemy}` is replaced by the other expedition's codename. */
export const HOSTILITY_MESSAGES = {
  playerStarted: 'Shots fired. The standoff is over — hostilities with {enemy} have begun.',
  aiStarted: '{enemy} has gone weapons-free. Their units are now hostile.',
  rising: 'Intelligence: {enemy} patrols are probing our perimeter. Tension is rising.',
};

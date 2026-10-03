/**
 * Characters: the foundation for the future Mount & Blade / X4-style player
 * avatar and named commanders. In the MVP they are data only:
 *  - every army can have an ArmyCommander,
 *  - each faction has a Commander leading the expedition,
 *  - the player is represented by a PlayerCharacter stationed at the HQ.
 *
 * Future direct-control gameplay (entering battles in person, piloting
 * vehicles/mechs, consciousness transfer) hangs off `controlMode` and
 * `location` without changing the campaign simulation.
 */

export type CharacterRole = 'expedition_director' | 'army_commander' | 'officer';

export interface CharacterSkills {
  /** Leadership: future morale / command capacity. */
  command: number;
  /** Supply efficiency. */
  logistics: number;
  /** Tactical bonus in battles. */
  tactics: number;
}

export type CharacterLocation =
  | { kind: 'base'; id: string }
  | { kind: 'army'; id: string }
  | { kind: 'none' };

export interface Character {
  id: string;
  name: string;
  factionId: string;
  role: CharacterRole;
  skills: CharacterSkills;
  alive: boolean;
  location: CharacterLocation;
  /** Present only on the player's avatar. */
  player?: PlayerCharacterData;
}

/** A Commander is any character that can lead forces. */
export type Commander = Character & { role: 'expedition_director' | 'army_commander' };

/** A commander attached to a specific army. */
export type ArmyCommander = Character & { role: 'army_commander'; location: { kind: 'army'; id: string } };

/**
 * How the player character exerts control. Only 'command_post' exists in the
 * MVP (classic strategy control). Planned: 'field_radio', 'direct_soldier',
 * 'vehicle_crew', 'remote_uplink', 'transferred_mind'.
 */
export type ControlMode = 'command_post';

export interface PlayerCharacterData {
  controlMode: ControlMode;
  /** Max simultaneous armies this character can command (future tech hook). */
  commandCapacity: number;
}

export type PlayerCharacter = Character & { player: PlayerCharacterData };

export function isPlayerCharacter(c: Character): c is PlayerCharacter {
  return !!c.player;
}

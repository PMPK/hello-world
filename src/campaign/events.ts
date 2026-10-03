import { EARTH_FLIGHT_MESSAGES, EARTH_SILENCE_MESSAGES } from '../data/lore';
import { depositToBase } from '../economy/economy';
import { log, type SimContext } from './context';
import { basesOf } from './queries';

export const MAX_EARTH_FLIGHTS = 6;

/**
 * Narrative/world events: supply shuttles from Earth (ever rarer) and
 * occasional signs that Earth communication is failing.
 */
export function stepEvents(ctx: SimContext, dt: number): void {
  const { state, rng } = ctx;
  if (state.earthFlights < MAX_EARTH_FLIGHTS && state.time >= state.nextEarthFlightAt) {
    state.earthFlights++;
    for (const f of Object.values(state.factions)) {
      const bases = basesOf(state, f.id).sort((a, b) => a.founded - b.founded);
      const base = bases[0];
      if (!base) continue;
      const people = Math.max(2, rng.int(5, 9) - state.earthFlights);
      base.population += people;
      depositToBase(state, base, { components: 8, ammo: 10, fuel: 6 });
      if (f.isPlayer) {
        const msg = EARTH_FLIGHT_MESSAGES[Math.min(EARTH_FLIGHT_MESSAGES.length - 1, Math.floor((state.earthFlights - 1) / 2))];
        log(state, `${msg} (+${people} personnel, supplies)`, 'lore', f.id);
      }
    }
    state.nextEarthFlightAt = state.time + 96 + state.earthFlights * 40 + rng.range(-12, 12);
    if (state.earthFlights >= MAX_EARTH_FLIGHTS) {
      log(state, 'Earth has stopped scheduling supply flights. No explanation was given.', 'lore');
    }
  }
  // Atmospheric hints after the first days.
  if (state.time > 96 && rng.next() < dt / 140) {
    log(state, rng.pick(EARTH_SILENCE_MESSAGES), 'lore');
  }
}

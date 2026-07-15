import { describe, expect, it } from 'vitest';

import * as surface from '../public-api';

/** The deliberate runtime surface of @sf/shared. Type exports are enforced by
 *  the compiler; this locks the 35 VALUE exports so a stray `export *` or leaked
 *  helper can't silently widen the contract the shared-gate CI defends. */
const VALUE_EXPORTS = [
  // services
  'Api',
  'Poll',
  'Theme',
  // UI kit primitives
  'Autofocus',
  'Avatar',
  'Glyph',
  'Icon',
  'Mark',
  'Pill',
  'Sig',
  'TrackChip',
  'TypeChip',
  // label tables
  'STAGE_LABEL',
  'TYPE_LABEL',
  'TYPE_SHORT',
  // pure helpers
  'adminStateLine',
  'boardGlyph',
  'clock',
  'confirmSteps',
  'elapsedShort',
  'evidenceBits',
  'gateLabel',
  'groupTrace',
  'healthLine',
  'inFlight',
  'liveStatus',
  'loadStoredUser',
  'missionRowLabel',
  'missionSubtitle',
  'missionSummary',
  'plainActivity',
  'plainStage',
  'prototypeSrcdoc',
  'timeAgo',
  'utc',
];

describe('@sf/shared public surface', () => {
  it('exports exactly the agreed value symbols', () => {
    expect(Object.keys(surface).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it('every agreed symbol is defined', () => {
    for (const name of VALUE_EXPORTS) {
      expect(surface[name as keyof typeof surface], name).toBeDefined();
    }
  });
});

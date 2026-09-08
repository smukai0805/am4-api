const overrides = new Map([
  ['1635714:541', {
    // Sources disagree on the shape label (4-3-3 vs 4-2-3-1), so keep the
    // provider formation and only correct the player roles they agree on.
    positions: new Map([
      [744, '4:3'],       // Brahim: right
      [129718, '4:2'],    // Bellingham: central
      [762, '4:1'],       // Vinicius: left
      [278, '5:1'],       // Mbappe: centre-forward
    ]),
    verifiedOn: '2026-09-08',
    sources: [
      {
        name: 'The Guardian',
        url: 'https://www.theguardian.com/football/live/2026/sep/08/real-madrid-v-inter-millwall-v-newcastle-champions-league-and-carabao-cup-live',
      },
      { name: 'OneFootball', evidence: 'user-supplied lineup screenshot' },
    ],
  }],
]);

const validOverride = entry => entry?.positions instanceof Map
  && new Set((entry.sources || []).map(source => source.name).filter(Boolean)).size >= 2;

export function applyVerifiedLineupOverride(fixtureId, lineup) {
  const entry = overrides.get(`${Number(fixtureId)}:${Number(lineup?.team?.id)}`);
  if (!validOverride(entry)) return lineup;
  const present = new Set((lineup.startXI || []).map(player => Number(player.id)));
  if ([...entry.positions.keys()].some(id => !present.has(id))) return lineup;
  return {
    ...lineup,
    startXI: lineup.startXI.map(player => entry.positions.has(Number(player.id))
      ? { ...player, grid: entry.positions.get(Number(player.id)) }
      : player),
    verification: {
      status: 'multi-source',
      verifiedOn: entry.verifiedOn,
      formationChanged: false,
      sources: entry.sources.map(source => ({ ...source })),
    },
  };
}

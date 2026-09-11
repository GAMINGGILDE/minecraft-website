import { describe, expect, it } from 'vitest';

import {
  buildMcHeadsAvatarUrl,
  buildMcHeadsSkinUrl,
  buildCraftheadHelmUrl,
  buildCraftheadSkinUrl,
  compactMinecraftUuid,
  resolvePlayerTextureId,
} from './playerTextures';

describe('playerTextures', () => {
  it('normalisiert UUIDs ohne Bindestriche', () => {
    expect(compactMinecraftUuid('00000000-0000-0000-0000-0000000000AB')).toBe(
      '000000000000000000000000000000ab',
    );
  });

  it('bevorzugt die UUID gegenueber dem Spielernamen', () => {
    expect(resolvePlayerTextureId('00000000-0000-0000-0000-0000000000AB', 'Steve')).toBe(
      '000000000000000000000000000000ab',
    );
  });

  it('faellt ohne UUID auf den Spielernamen zurueck', () => {
    expect(resolvePlayerTextureId('', 'Steve')).toBe('Steve');
  });

  it('baut Kopf-URLs bevorzugt mit UUID', () => {
    expect(buildCraftheadHelmUrl('00000000-0000-0000-0000-0000000000AB', 'Steve', 32)).toBe(
      'https://crafthead.net/helm/000000000000000000000000000000ab/32',
    );
    expect(buildCraftheadHelmUrl('00000000-0000-0000-0000-0000000000AB', 'Steve', 512)).toBe(
      'https://crafthead.net/helm/000000000000000000000000000000ab/300',
    );
    expect(buildMcHeadsAvatarUrl('00000000-0000-0000-0000-0000000000AB', 'Steve', 32)).toBe(
      'https://mc-heads.net/avatar/000000000000000000000000000000ab/32',
    );
  });

  it('baut Skin-URLs bevorzugt mit UUID', () => {
    expect(buildCraftheadSkinUrl('00000000-0000-0000-0000-0000000000AB', 'Steve')).toBe(
      'https://crafthead.net/skin/000000000000000000000000000000ab',
    );
    expect(buildMcHeadsSkinUrl('00000000-0000-0000-0000-0000000000AB', 'Steve')).toBe(
      'https://mc-heads.net/skin/000000000000000000000000000000ab',
    );
  });
});

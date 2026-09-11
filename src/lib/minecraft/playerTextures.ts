export function compactMinecraftUuid(input: string | null | undefined): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
}

export function resolvePlayerTextureId(uuid?: string | null, name?: string | null): string {
  const compactUuid = compactMinecraftUuid(uuid);
  if (compactUuid) return compactUuid;
  return String(name || '').trim();
}

export function buildCraftheadHelmUrl(
  uuid?: string | null,
  name?: string | null,
  size = 80,
): string {
  const textureId = resolvePlayerTextureId(uuid, name);
  const imageSize = Math.min(300, Math.max(8, Math.round(size)));
  return textureId
    ? `https://crafthead.net/helm/${encodeURIComponent(textureId)}/${imageSize}`
    : '';
}

export function buildMcHeadsAvatarUrl(
  uuid?: string | null,
  name?: string | null,
  size = 80,
): string {
  const textureId = resolvePlayerTextureId(uuid, name);
  return textureId ? `https://mc-heads.net/avatar/${encodeURIComponent(textureId)}/${size}` : '';
}

export function buildCraftheadSkinUrl(uuid?: string | null, name?: string | null): string {
  const textureId = resolvePlayerTextureId(uuid, name);
  return textureId ? `https://crafthead.net/skin/${encodeURIComponent(textureId)}` : '';
}

export function buildMcHeadsSkinUrl(uuid?: string | null, name?: string | null): string {
  const textureId = resolvePlayerTextureId(uuid, name);
  return textureId ? `https://mc-heads.net/skin/${encodeURIComponent(textureId)}` : '';
}

import { useEffect, useState, type ImgHTMLAttributes } from 'react';

import {
  buildMcHeadsAvatarUrl,
  buildCraftheadHelmUrl,
} from '../../../lib/minecraft/playerTextures';

type PlayerAvatarProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  uuid?: string | null;
  name?: string | null;
  size?: number;
};

export function PlayerAvatar({
  uuid,
  name,
  size = 32,
  onError,
  alt = '',
  ...imgProps
}: PlayerAvatarProps) {
  const primarySrc = buildCraftheadHelmUrl(uuid, name, size);
  const fallbackSrc = buildMcHeadsAvatarUrl(uuid, name, size);
  const [src, setSrc] = useState(primarySrc);
  const [fallbackAttempted, setFallbackAttempted] = useState(false);

  useEffect(() => {
    setSrc(primarySrc);
    setFallbackAttempted(false);
  }, [primarySrc]);

  return (
    <img
      {...imgProps}
      src={src}
      alt={alt}
      onError={(event) => {
        if (!fallbackAttempted && fallbackSrc && src !== fallbackSrc) {
          setFallbackAttempted(true);
          setSrc(fallbackSrc);
          return;
        }

        onError?.(event);
      }}
    />
  );
}

import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import headerBackgroundImage from '../../assets/images/home/header-background.webp';

export type GalleryImage = {
  src: string;
  srcset: string;
  sizes: string;
  width: number;
  height: number;
};

const modules = import.meta.glob<{ default: ImageMetadata }>(
  '../../assets/images/home/gallery/*.{png,jpg,jpeg,webp,avif}',
  { eager: true },
);

// Auch Folgebilder bekommen beim Build dieselben responsiven Varianten wie das Startbild.
export async function getHomeGallery(): Promise<GalleryImage[]> {
  const sources = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true }))
    .map(([, module]) => module.default);
  if (sources.length === 0) sources.push(headerBackgroundImage);

  return Promise.all(
    sources.map(async (src) => {
      const width = Math.min(1920, src.width);
      const height = Math.round((src.height * width) / src.width);
      const sizes = '(min-width: 1024px) 50vw, 100vw';
      const image = await getImage({
        src,
        width,
        height,
        format: 'webp',
        sizes,
        widths: [...new Set([768, 1280, width].filter((value) => value <= width))],
      });
      return { src: image.src, srcset: image.srcSet.attribute, sizes, width, height };
    }),
  );
}

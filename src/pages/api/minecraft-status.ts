import type { APIRoute } from 'astro';
import { handleMinecraftStatus } from '../../lib/http/server/minecraftStatus';

export const prerender = false;

export const GET: APIRoute = ({ request }) => handleMinecraftStatus(request);
export const HEAD: APIRoute = GET;

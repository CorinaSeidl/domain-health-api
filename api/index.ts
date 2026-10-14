import { handle } from "../src/http/vercel.js";

// vercel.json rewrites GET / here: the landing page (LP-1).
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;

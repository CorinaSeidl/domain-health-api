import { handle } from "../src/http/vercel.js";

// vercel.json rewrites every unknown path here so it gets the JSON 404 envelope (HTTP-3).
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;

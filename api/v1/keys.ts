import { handle } from "../../src/http/vercel.js";

// Every method is exported so the handler can answer non-POST with a JSON 405 (KEY-1).
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
